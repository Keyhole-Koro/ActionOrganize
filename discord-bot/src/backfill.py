"""Backfill — fetch past Discord messages and save to GCS.

Called automatically on bot startup (on_ready) to:
  - Initial setup: import full message history when no GCS data exists for a channel
  - Gap fill: import messages missed while the bot was offline
"""
from __future__ import annotations

import logging

import discord
from google.cloud import storage

from firestore_store import index_message_structure, resolve_workspace_binding
from gcs_store import save_to_gcs

log = logging.getLogger(__name__)


def _latest_message_id_in_gcs(bucket: storage.Bucket, workspace_id: str, container_id: str) -> int | None:
    """Return the snowflake ID of the latest saved message, or None."""
    prefix = f"discord/{workspace_id}/{container_id}/"
    latest_id = None
    for blob in bucket.list_blobs(prefix=prefix):
        name = blob.name.rsplit("/", 1)[-1].replace(".json", "")
        try:
            msg_id = int(name)
            if latest_id is None or msg_id > latest_id:
                latest_id = msg_id
        except ValueError:
            pass
    return latest_id


async def _backfill_channel(
    bucket: storage.Bucket,
    workspace_id: str,
    bucket_name: str,
    channel: discord.TextChannel | discord.Thread,
) -> int:
    """Backfill a single channel or thread. Returns number of messages saved."""
    container_id = str(channel.id)
    latest_id = _latest_message_id_in_gcs(bucket, workspace_id, container_id)
    after = discord.Object(id=latest_id) if latest_id else None

    saved = 0
    async for message in channel.history(limit=None, after=after, oldest_first=True):
        if message.author.bot:
            continue
        if not message.content.strip():
            continue
        try:
            save_to_gcs(message, workspace_id, bucket_name)
            index_message_structure(message, workspace_id)
            saved += 1
        except Exception:
            log.exception("backfill: failed to save message id=%s", message.id)

    return saved


async def run_backfill(bot_client: discord.Client, bucket_name: str) -> None:
    """Entrypoint: called from on_ready(). Backfills all bound guilds/channels."""
    gcs = storage.Client()
    bucket = gcs.bucket(bucket_name)

    for guild in bot_client.guilds:
        binding = resolve_workspace_binding(str(guild.id))
        if binding is None:
            log.info("backfill: skipping guild without workspace binding guild_id=%s", guild.id)
            continue

        workspace_id = binding["workspace_id"]
        log.info("backfill: starting guild=%s workspace=%s", guild.name, workspace_id)
        total = 0

        # テキストチャンネル
        for channel in guild.text_channels:
            try:
                saved = await _backfill_channel(bucket, workspace_id, bucket_name, channel)
                if saved:
                    log.info("backfill: channel=%s saved=%d", channel.name, saved)
                total += saved
            except discord.Forbidden:
                log.warning("backfill: no access to channel=%s", channel.name)
            except Exception:
                log.exception("backfill: error in channel=%s", channel.name)

            # アーカイブ済みスレッド（APIコール）
            try:
                async for thread in channel.archived_threads(limit=None):
                    saved = await _backfill_channel(bucket, workspace_id, bucket_name, thread)
                    if saved:
                        log.info("backfill: archived_thread=%s saved=%d", thread.name, saved)
                    total += saved
            except discord.Forbidden:
                log.warning("backfill: no access to archived threads for channel=%s", channel.name)
            except Exception:
                log.exception("backfill: error fetching archived threads for channel=%s", channel.name)

        # アクティブスレッド（APIコール・ギルド全体）
        try:
            for thread in await guild.active_threads():
                saved = await _backfill_channel(bucket, workspace_id, bucket_name, thread)
                if saved:
                    log.info("backfill: active_thread=%s saved=%d", thread.name, saved)
                total += saved
        except discord.Forbidden:
            log.warning("backfill: no access to active threads guild=%s", guild.name)
        except Exception:
            log.exception("backfill: error fetching active threads guild=%s", guild.name)

        log.info("backfill: done guild=%s workspace=%s total_saved=%d", guild.name, workspace_id, total)
