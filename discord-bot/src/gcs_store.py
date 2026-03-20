"""GCS writer — stores each Discord message as an individual JSON object (Case A)."""
from __future__ import annotations

import json
import logging
from datetime import timezone

import discord
from google.cloud import storage

log = logging.getLogger(__name__)
_client: storage.Client | None = None


def _get_client() -> storage.Client:
    global _client
    if _client is None:
        _client = storage.Client()
    return _client


def _channel_info(channel) -> dict:
    if isinstance(channel, discord.Thread):
        parent = channel.parent
        return {
            "thread_id": str(channel.id),
            "thread_name": channel.name,
            "channel_id": str(parent.id) if parent else None,
            "channel_name": parent.name if parent else None,
            "channel_type": "thread",
        }
    cat = getattr(channel, "category", None)
    return {
        "thread_id": None,
        "thread_name": None,
        "channel_id": str(channel.id),
        "channel_name": getattr(channel, "name", str(channel.id)),
        "channel_type": "text",
    }


def save_to_gcs(
    message: discord.Message,
    workspace_id: str,
    bucket_name: str,
) -> str:
    """Write a single Discord message to GCS. Returns the GCS blob path."""
    ch = _channel_info(message.channel)

    cat = getattr(message.channel, "category", None)
    if cat is None and hasattr(message.channel, "parent"):
        cat = getattr(message.channel.parent, "category", None)

    # Path: discord/{workspace_id}/{channel_id or thread_id}/{message_id}.json
    container_id = ch["thread_id"] or ch["channel_id"]
    blob_path = f"discord/{workspace_id}/{container_id}/{message.id}.json"

    doc = {
        "message_id": str(message.id),
        "workspace_id": workspace_id,
        "guild_id": str(message.guild.id),
        "guild_name": message.guild.name,
        "category_id": str(cat.id) if cat else None,
        "category_name": cat.name if cat else None,
        **ch,
        "author_id": str(message.author.id),
        "author_name": str(message.author),
        "content": message.content,
        "timestamp": message.created_at.replace(tzinfo=timezone.utc).isoformat(),
    }

    bucket = _get_client().bucket(bucket_name)
    blob = bucket.blob(blob_path)
    blob.upload_from_string(
        json.dumps(doc, ensure_ascii=False),
        content_type="application/json",
    )
    log.debug("gcs saved path=%s", blob_path)
    return blob_path
