"""Firestore helpers for Discord bot workspace binding and structure index."""
from __future__ import annotations

import logging
from datetime import UTC, datetime

import discord
from google.cloud import firestore

log = logging.getLogger(__name__)
_client: firestore.Client | None = None


def _get_client() -> firestore.Client:
    global _client
    if _client is None:
        _client = firestore.Client()
    return _client


def resolve_workspace_binding(guild_id: str) -> dict | None:
    """Resolve guild_id -> workspace binding from Firestore."""
    snapshot = _get_client().collection("discord_guild_bindings").document(guild_id).get()
    if not snapshot.exists:
        return None
    data = snapshot.to_dict() or {}
    if not data.get("enabled", False):
        return None
    if data.get("status") != "active":
        return None
    workspace_id = str(data.get("workspaceId", "")).strip()
    if not workspace_id:
        log.warning("discord_guild_bindings/%s missing workspaceId", guild_id)
        return None
    return {
        "workspace_id": workspace_id,
        "guild_name": data.get("guildName"),
    }


def index_message_structure(message: discord.Message, workspace_id: str) -> None:
    """Upsert Discord channel/thread metadata for downstream readers."""
    db = _get_client()
    guild = message.guild
    channel = message.channel

    if isinstance(channel, discord.Thread):
        parent = channel.parent
        if parent is not None:
            db.collection(f"workspaces/{workspace_id}/discord_channels").document(str(parent.id)).set(
                {
                    "guild_id": str(guild.id),
                    "guild_name": guild.name,
                    "name": parent.name,
                    "category_id": str(parent.category.id) if parent.category else None,
                    "category_name": parent.category.name if parent.category else None,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
        db.collection(f"workspaces/{workspace_id}/discord_threads").document(str(channel.id)).set(
            {
                "guild_id": str(guild.id),
                "guild_name": guild.name,
                "name": channel.name,
                "channel_id": str(parent.id) if parent else None,
                "channel_name": parent.name if parent else None,
                "updated_at": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        return

    db.collection(f"workspaces/{workspace_id}/discord_channels").document(str(channel.id)).set(
        {
            "guild_id": str(guild.id),
            "guild_name": guild.name,
            "name": channel.name,
            "category_id": str(channel.category.id) if channel.category else None,
            "category_name": channel.category.name if channel.category else None,
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )


def attach_guild_join_candidates(guild: discord.Guild) -> int:
    """Attach a guild join candidate to all non-expired pending install sessions.

    The final workspace binding is still confirmed by the user via act-api.
    """
    db = _get_client()
    now = datetime.now(UTC)
    sessions = db.collection("discord_install_sessions").where("status", "==", "pending").stream()

    matched = 0
    for session in sessions:
        data = session.to_dict() or {}
        expires_at = data.get("expiresAt")
        if hasattr(expires_at, "to_datetime"):
            expires_at = expires_at.to_datetime()
        if isinstance(expires_at, datetime):
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=UTC)
            if expires_at <= now:
                continue

        session.reference.collection("candidates").document(str(guild.id)).set(
            {
                "guildId": str(guild.id),
                "guildName": guild.name,
                "source": "guild_join",
                "joinedAt": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        session.reference.set(
            {
                "status": "awaiting_confirmation",
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        matched += 1

    return matched
