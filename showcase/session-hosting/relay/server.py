#!/usr/bin/env python3
"""Opaque, bounded HTTP relay for cc-host/v1. Never decrypts or logs packets."""

import asyncio
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
import time
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from aiohttp import web

PREFIX = "/cc-host/v1"
MAX_BODY = 4 * 1024 * 1024
MAX_PACKET = 3 * 1024 * 1024
ID_RE = re.compile(r"[0-9a-f]{32}\Z")
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}\Z")
HASH_RE = re.compile(r"[0-9a-f]{64}\Z")
PACKET_RE = re.compile(r"[A-Za-z0-9_-]+\Z")
LOG = logging.getLogger("cc_host_relay")


class RelayError(Exception):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code


def reply(data: dict, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, headers={
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    })


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


@dataclass(frozen=True)
class Config:
    enroll_token: str
    state_path: str | Path
    bind: str = "127.0.0.1"
    port: int = 7865
    poll_timeout: float = 20.0
    rpc_timeout: float = 25.0
    max_rooms: int = 32
    room_pending: int = 16
    global_pending: int = 64
    # An extra memory ceiling: 64 packets at the wire maximum need not fit RAM.
    pending_bytes: int = 48 * 1024 * 1024

    def __post_init__(self):
        if not isinstance(self.enroll_token, str) or not TOKEN_RE.fullmatch(self.enroll_token):
            raise ValueError("CC_HOST_ENROLL_TOKEN must be a 43-character base64url token")
        if not Path(self.state_path).is_absolute():
            raise ValueError("CC_HOST_STATE must be an absolute path")
        if not 0 < self.poll_timeout <= 20 or not 0 < self.rpc_timeout <= 25:
            raise ValueError("timeouts exceed protocol limits")
        for value, limit in ((self.max_rooms, 32), (self.room_pending, 16), (self.global_pending, 64)):
            if not isinstance(value, int) or not 1 <= value <= limit:
                raise ValueError("invalid relay capacity")
        if not isinstance(self.pending_bytes, int) or self.pending_bytes < 1:
            raise ValueError("invalid memory limit")
        if not isinstance(self.port, int) or not 0 <= self.port <= 65535:
            raise ValueError("invalid port")

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            enroll_token=os.environ.get("CC_HOST_ENROLL_TOKEN", ""),
            state_path=os.environ.get("CC_HOST_STATE", "/var/lib/cc-host-relay/rooms.json"),
            bind=os.environ.get("CC_HOST_BIND", "127.0.0.1"),
            port=int(os.environ.get("CC_HOST_PORT", "7865")),
        )


def unique_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate JSON key")
        out[key] = value
    return out


class StateStore:
    def __init__(self, filename: str | Path):
        self.path = Path(filename)
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

    def load(self) -> dict[str, dict[str, str]]:
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return {}
        with os.fdopen(fd, "rb") as src:
            st = os.fstat(src.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size > 128 * 1024:
                raise ValueError("invalid relay state file")
            os.fchmod(src.fileno(), 0o600)
            data = json.loads(src.read().decode("utf-8"), object_pairs_hook=unique_object)
        if not isinstance(data, dict) or set(data) != {"v", "rooms"} or data["v"] != 1:
            raise ValueError("invalid relay state schema")
        rooms = data["rooms"]
        if not isinstance(rooms, dict) or len(rooms) > 32:
            raise ValueError("invalid relay room count")
        for room_id, tokens in rooms.items():
            if not ID_RE.fullmatch(room_id) or not isinstance(tokens, dict):
                raise ValueError("invalid relay room")
            if set(tokens) != {"hostSha256", "clientSha256"}:
                raise ValueError("invalid relay token record")
            if any(not isinstance(x, str) or not HASH_RE.fullmatch(x) for x in tokens.values()):
                raise ValueError("invalid relay token hash")
            if tokens["hostSha256"] == tokens["clientSha256"]:
                raise ValueError("room roles must have different tokens")
        return rooms

    def save(self, rooms: dict[str, dict[str, str]]) -> None:
        encoded = json.dumps({"v": 1, "rooms": rooms}, separators=(",", ":")).encode("utf-8")
        fd, temporary = tempfile.mkstemp(prefix=".rooms-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "wb") as dst:
                os.fchmod(dst.fileno(), 0o600)
                dst.write(encoded)
                dst.flush()
                os.fsync(dst.fileno())
            os.replace(temporary, self.path)
            parent_fd = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


@dataclass
class Pending:
    packet: str
    future: asyncio.Future
    deadline: float


@dataclass
class Room:
    tokens: dict[str, str]
    pending: dict[str, Pending] = field(default_factory=dict)
    queue: deque = field(default_factory=deque)
    available: asyncio.Event = field(default_factory=asyncio.Event)
    polling: bool = False
    deleted: bool = False


async def wait_connected(request: web.Request, awaitable, timeout: float):
    """Cancel waiters even under an AppRunner without handler_cancellation enabled."""
    waiter = asyncio.ensure_future(awaitable)

    async def disconnected():
        while request.transport is not None and not request.transport.is_closing():
            await asyncio.sleep(0.2)
        return None

    monitor = asyncio.create_task(disconnected())
    try:
        done, _ = await asyncio.wait({waiter, monitor}, timeout=timeout,
                                     return_when=asyncio.FIRST_COMPLETED)
        if monitor in done:
            raise asyncio.CancelledError
        if waiter in done:
            return waiter.result()
        raise TimeoutError
    finally:
        waiter.cancel()
        monitor.cancel()
        await asyncio.gather(waiter, monitor, return_exceptions=True)


class Relay:
    def __init__(self, config: Config):
        self.config = config
        self.store = StateStore(config.state_path)
        records = self.store.load()
        if len(records) > config.max_rooms:
            raise ValueError("stored room count exceeds configured capacity")
        self.rooms = {key: Room(tokens) for key, tokens in records.items()}
        self.enroll_hash = digest(config.enroll_token)
        self.total_pending = 0
        self.total_bytes = 0
        self.closing = False

    def token_hash(self, request: web.Request) -> str:
        authorization = request.headers.getall("Authorization", [])
        if len(authorization) != 1 or not authorization[0].startswith("Bearer "):
            raise RelayError(401, "unauthorized")
        token = authorization[0][7:]
        if not TOKEN_RE.fullmatch(token):
            raise RelayError(401, "unauthorized")
        return digest(token)

    def authenticate(self, request: web.Request, role: str) -> tuple[str, Room]:
        hashed = self.token_hash(request)
        room_id = request.match_info["room"]
        room = self.rooms.get(room_id) if ID_RE.fullmatch(room_id) else None
        expected = room.tokens[role + "Sha256"] if room else "0" * 64
        if not hmac.compare_digest(hashed, expected) or room is None or room.deleted:
            raise RelayError(401, "unauthorized")
        return room_id, room

    async def read_json(self, request: web.Request) -> dict:
        if request.content_type != "application/json":
            raise RelayError(415, "json_required")
        if request.charset and request.charset.lower() not in {"utf-8", "utf8"}:
            raise RelayError(415, "utf8_required")
        if request.headers.get("Content-Encoding", "identity").lower() != "identity":
            raise RelayError(415, "encoding_not_supported")
        if request.content_length is not None and request.content_length > MAX_BODY:
            raise RelayError(413, "body_too_large")
        body = bytearray()
        try:
            async with asyncio.timeout(10):
                async for chunk in request.content.iter_chunked(64 * 1024):
                    body.extend(chunk)
                    if len(body) > MAX_BODY:
                        raise RelayError(413, "body_too_large")
        except TimeoutError:
            raise RelayError(408, "body_timeout") from None
        try:
            data = json.loads(body.decode("utf-8"), object_pairs_hook=unique_object)
        except (ValueError, RecursionError, UnicodeError):
            raise RelayError(400, "bad_json") from None
        if not isinstance(data, dict):
            raise RelayError(400, "bad_json")
        return data

    @staticmethod
    def packet(data: dict) -> tuple[str, str]:
        if set(data) != {"id", "packet"}:
            raise RelayError(400, "bad_packet")
        request_id, packet = data["id"], data["packet"]
        if not isinstance(request_id, str) or not ID_RE.fullmatch(request_id):
            raise RelayError(400, "bad_id")
        if not isinstance(packet, str) or not packet or len(packet) > MAX_PACKET:
            raise RelayError(413 if isinstance(packet, str) and len(packet) > MAX_PACKET else 400,
                             "bad_packet")
        if len(packet) % 4 == 1 or not PACKET_RE.fullmatch(packet):
            raise RelayError(400, "bad_packet")
        return request_id, packet

    async def health(self, request):
        return reply({"ok": True, "protocol": 1})

    async def create_room(self, request):
        if not hmac.compare_digest(self.token_hash(request), self.enroll_hash):
            raise RelayError(401, "unauthorized")
        if await self.read_json(request) != {}:
            raise RelayError(400, "empty_object_required")
        if self.closing:
            raise RelayError(503, "relay_stopping")
        if len(self.rooms) >= self.config.max_rooms:
            raise RelayError(429, "room_limit")
        room_id = secrets.token_hex(16)
        while room_id in self.rooms:
            room_id = secrets.token_hex(16)
        host_token, client_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        tokens = {"hostSha256": digest(host_token), "clientSha256": digest(client_token)}
        records = {key: value.tokens for key, value in self.rooms.items()}
        records[room_id] = tokens
        self.store.save(records)
        self.rooms[room_id] = Room(tokens)
        return reply({"room": room_id, "hostToken": host_token, "clientToken": client_token})

    def remove_pending(self, room: Room, request_id: str, expected: Pending) -> None:
        if room.pending.get(request_id) is not expected:
            return
        del room.pending[request_id]
        self.total_pending -= 1
        self.total_bytes -= len(expected.packet)
        try:
            room.queue.remove(request_id)
        except ValueError:
            pass
        if not room.queue and not room.deleted:
            room.available.clear()
        if not expected.future.done():
            expected.future.cancel()

    def close_room(self, room: Room, reason: str):
        room.deleted = True
        for request_id, pending in list(room.pending.items()):
            if not pending.future.done():
                pending.future.set_result((503, reason))
            self.remove_pending(room, request_id, pending)
        room.queue.clear()
        room.available.set()

    async def delete_room(self, request):
        room_id, room = self.authenticate(request, "host")
        records = {key: value.tokens for key, value in self.rooms.items() if key != room_id}
        self.store.save(records)
        del self.rooms[room_id]
        self.close_room(room, "room_closed")
        return reply({"ok": True})

    async def poll(self, request):
        _, room = self.authenticate(request, "host")
        if room.polling:
            raise RelayError(409, "poll_in_progress")
        room.polling = True
        deadline = time.monotonic() + self.config.poll_timeout
        try:
            while True:
                if room.deleted or self.closing:
                    raise RelayError(503, "room_closed")
                packets = []
                while room.queue and len(packets) < 4:
                    request_id = room.queue.popleft()
                    pending = room.pending.get(request_id)
                    if not pending:
                        continue
                    if pending.deadline <= time.monotonic() or pending.future.done():
                        if not pending.future.done():
                            pending.future.set_result((504, "host_timeout"))
                        self.remove_pending(room, request_id, pending)
                        continue
                    packets.append({"id": request_id, "packet": pending.packet})
                if not room.queue:
                    room.available.clear()
                if packets:
                    return reply({"requests": packets})
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return reply({"requests": []})
                try:
                    await wait_connected(request, room.available.wait(), remaining)
                except TimeoutError:
                    return reply({"requests": []})
        finally:
            room.polling = False

    async def rpc(self, request):
        _, room = self.authenticate(request, "client")
        request_id, packet = self.packet(await self.read_json(request))
        # The room can be deleted while the request body is arriving.
        if room.deleted or self.closing:
            raise RelayError(503, "room_closed")
        if request_id in room.pending:
            raise RelayError(409, "duplicate_request")
        if len(room.pending) >= self.config.room_pending:
            raise RelayError(429, "room_busy")
        if self.total_pending >= self.config.global_pending:
            raise RelayError(429, "relay_busy")
        if self.total_bytes + len(packet) > self.config.pending_bytes:
            raise RelayError(429, "relay_busy")
        future = asyncio.get_running_loop().create_future()
        pending = Pending(packet, future, time.monotonic() + self.config.rpc_timeout)
        room.pending[request_id] = pending
        room.queue.append(request_id)
        self.total_pending += 1
        self.total_bytes += len(packet)
        room.available.set()
        try:
            try:
                status, value = await wait_connected(request, asyncio.shield(future), self.config.rpc_timeout)
            except TimeoutError:
                raise RelayError(504, "host_timeout") from None
            if status != 200:
                raise RelayError(status, value)
            return reply({"id": request_id, "packet": value})
        finally:
            self.remove_pending(room, request_id, pending)

    async def host_reply(self, request):
        _, room = self.authenticate(request, "host")
        request_id, packet = self.packet(await self.read_json(request))
        pending = room.pending.get(request_id)
        if room.deleted or pending is None or pending.future.done():
            raise RelayError(409, "request_gone")
        if pending.deadline <= time.monotonic():
            pending.future.set_result((504, "host_timeout"))
            self.remove_pending(room, request_id, pending)
            raise RelayError(409, "request_gone")
        # A reply for a still-queued id is invalid: it has not reached the host.
        if request_id in room.queue:
            raise RelayError(409, "request_not_delivered")
        pending.future.set_result((200, packet))
        # Keep the id reserved until the waiting RPC handler has consumed its reply.
        # Otherwise an overlapping retry can enqueue the same id a second time.
        return reply({"ok": True})

    async def shutdown(self, app):
        self.closing = True
        for room in self.rooms.values():
            self.close_room(room, "relay_stopping")


RELAY_KEY = web.AppKey("cc_host_relay", Relay)


@web.middleware
async def boundary(request, handler):
    try:
        if "Origin" in request.headers:
            raise RelayError(403, "origin_forbidden")
        if request.query_string:
            raise RelayError(400, "query_not_supported")
        if request.app[RELAY_KEY].closing:
            raise RelayError(503, "relay_stopping")
        response = await handler(request)
        return response
    except RelayError as exc:
        response = reply({"error": exc.code}, exc.status)
    except web.HTTPException as exc:
        codes = {404: "not_found", 405: "method_not_allowed", 413: "body_too_large"}
        response = reply({"error": codes.get(exc.status, "bad_request")}, exc.status)
    except (ConnectionError, asyncio.CancelledError):
        raise
    except Exception:
        # Do not stringify exceptions: a parser/library might include credentials.
        LOG.error("Relay request failed")
        response = reply({"error": "internal_error"}, 500)
    # Rejected/oversized bodies are not drained; close instead of buffering them.
    response.force_close()
    return response


def create_app(config: Config | Mapping[str, Any] | None = None) -> web.Application:
    if config is None:
        config = Config.from_env()
    elif isinstance(config, Mapping):
        config = Config(**config)
    if not isinstance(config, Config):
        raise TypeError("config must be Config or a mapping")
    relay = Relay(config)
    app = web.Application(client_max_size=MAX_BODY, middlewares=[boundary],
                          handler_args={"handler_cancellation": True, "auto_decompress": False})
    app[RELAY_KEY] = relay
    app.router.add_get(PREFIX + "/health", relay.health, allow_head=False)
    app.router.add_post(PREFIX + "/rooms", relay.create_room)
    app.router.add_delete(PREFIX + "/rooms/{room}", relay.delete_room)
    app.router.add_get(PREFIX + "/rooms/{room}/poll", relay.poll, allow_head=False)
    app.router.add_post(PREFIX + "/rooms/{room}/rpc", relay.rpc)
    app.router.add_post(PREFIX + "/rooms/{room}/reply", relay.host_reply)
    app.on_shutdown.append(relay.shutdown)
    return app


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    # aiohttp's low-level parser diagnostics can include the offending request.
    logging.getLogger("aiohttp.server").disabled = True
    logging.getLogger("aiohttp.access").disabled = True
    try:
        config = Config.from_env()
        app = create_app(config)
    except Exception:
        LOG.error("Relay configuration or state is invalid; refusing to start")
        raise SystemExit(1) from None
    web.run_app(app, host=config.bind, port=config.port, access_log=None, print=None,
                handler_cancellation=True, shutdown_timeout=5)


if __name__ == "__main__":
    main()
