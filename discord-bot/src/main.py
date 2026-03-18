"""Discord Bot — writes each message to GCS, then fires a Pub/Sub event."""
from __future__ import annotations

import logging
import os

import discord
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
GUILD_IDS = {int(g) for g in _require("DISCORD_GUILD_IDS").split(",") if g.strip()}
PROJECT_ID = _require("GOOGLE_CLOUD_PROJECT")
GCS_BUCKET = _require("GCS_BUCKET")
PUBSUB_TOPIC = os.environ.get("PUBSUB_DISCORD_TOPIC", "discord-message-received")
WORKSPACE_ID = os.environ.get("WORKSPACE_ID", "default")

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)


@client.event
async def on_ready() -> None:
    log.info("Discord bot ready. user=%s guilds=%s", client.user, list(GUILD_IDS))


@client.event
async def on_message(message: discord.Message) -> None:
    if message.author.bot:
        return
    if message.guild is None or message.guild.id not in GUILD_IDS:
        return
    if not message.content.strip():
        return

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
        gcs_path = save_to_gcs(message, WORKSPACE_ID, GCS_BUCKET)
        log.info(
            "stored guild=%s channel=%s author=%s gcs=%s",
            message.guild.name,
            getattr(channel, "name", channel.id),
            message.author,
            gcs_path,
        )
    except Exception:
        log.exception("Failed to store message id=%s to GCS", message.id)
        return

    try:
        publish_discord_message(
            workspace_id=WORKSPACE_ID,
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
