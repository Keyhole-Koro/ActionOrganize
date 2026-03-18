"""Pub/Sub publisher — fires discord.message.received events after GCS write."""
from __future__ import annotations

import json
import logging
import os

from google.cloud import pubsub_v1

log = logging.getLogger(__name__)
_publisher: pubsub_v1.PublisherClient | None = None


def _get_publisher() -> pubsub_v1.PublisherClient:
    global _publisher
    if _publisher is None:
        _publisher = pubsub_v1.PublisherClient()
    return _publisher


def publish_discord_message(
    *,
    workspace_id: str,
    project_id: str,
    topic_name: str,
    message_id: str,
    channel_id: str | None,
    thread_id: str | None,
    guild_id: str,
    gcs_path: str,
) -> None:
    """Publish a discord.message.received event to Pub/Sub (fire and forget)."""
    topic_path = _get_publisher().topic_path(project_id, topic_name)
    payload = json.dumps({
        "messageId": message_id,
        "workspaceId": workspace_id,
        "guildId": guild_id,
        "channelId": channel_id,
        "threadId": thread_id,
        "gcsPath": gcs_path,
    }).encode()

    future = _get_publisher().publish(
        topic_path,
        payload,
        type="discord.message.received",
        workspaceId=workspace_id,
    )
    future.add_done_callback(
        lambda f: log.debug("pubsub published message_id=%s", message_id)
        if not f.exception()
        else log.warning("pubsub publish failed: %s", f.exception())
    )
