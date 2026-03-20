"""Discord Bot — writes each message to GCS, then fires a Pub/Sub event."""
from __future__ import annotations

import logging
import os

import discord
from firestore_store import (
    attach_guild_join_candidates,
    index_message_structure,
    resolve_workspace_binding,
)
from gcs_store import save_to_gcs
from pubsub_publisher import publish_discord_message

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


def _require(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise RuntimeError(f"Required env var not set: {name}")
    return val


TOKEN = _require("DISCORD_BOT_TOKEN")
PROJECT_ID = _require("GOOGLE_CLOUD_PROJECT")
GCS_BUCKET = _require("GCS_BUCKET")
PUBSUB_TOPIC = _require("PUBSUB_TOPIC_NAME")

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)


@client.event
async def on_ready() -> None:
    log.info("Discord bot ready. user=%s", client.user)


@client.event
async def on_guild_join(guild: discord.Guild) -> None:
    try:
        matched = attach_guild_join_candidates(guild)
        log.info(
            "guild join recorded guild_id=%s guild_name=%s pending_sessions=%s",
            guild.id,
            guild.name,
            matched,
        )
    except Exception:
        log.exception("Failed to record guild join guild_id=%s", guild.id)


@client.event
async def on_message(message: discord.Message) -> None:
    if message.author.bot:
        return
    if message.guild is None:
        return
    if not message.content.strip():
        return

    binding = resolve_workspace_binding(str(message.guild.id))
    if binding is None:
        log.info("ignoring guild without workspace binding guild_id=%s", message.guild.id)
        return
    workspace_id = binding["workspace_id"]

    channel = message.channel
    channel_id = None
    thread_id = None
    if isinstance(channel, discord.Thread):
        thread_id = str(channel.id)
        if channel.parent:
            channel_id = str(channel.parent.id)
    else:
        channel_id = str(channel.id)

    try:
        gcs_path = save_to_gcs(message, workspace_id, GCS_BUCKET)
        index_message_structure(message, workspace_id)
        log.info(
            "stored workspace=%s guild_id=%s guild=%s channel_id=%s thread_id=%s author=%s gcs=%s",
            workspace_id,
            message.guild.id,
            message.guild.name,
            channel_id,
            thread_id,
            message.author,
            gcs_path,
        )
    except Exception:
        log.exception("Failed to store message id=%s to GCS", message.id)
        return

    try:
        publish_discord_message(
            workspace_id=workspace_id,
            project_id=PROJECT_ID,
            topic_name=PUBSUB_TOPIC,
            message_id=str(message.id),
            channel_id=channel_id,
            thread_id=thread_id,
            guild_id=str(message.guild.id),
            gcs_path=gcs_path,
        )
    except Exception:
        log.exception("Failed to publish Pub/Sub event for message id=%s", message.id)
        # Non-fatal: GCS write succeeded, Pub/Sub failure only delays knowledge graph update


if __name__ == "__main__":
    client.run(TOKEN)
