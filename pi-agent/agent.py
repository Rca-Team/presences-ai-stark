#!/usr/bin/env python3
"""
Presence AI — Raspberry Pi attendance kiosk agent.

Plug and play: on boot this agent syncs the face gallery from the cloud,
watches the camera, recognizes students locally and pushes attendance to the
Presence web app. It keeps working offline and flushes queued attendance once
the network is back.

Config comes from environment variables (see kiosk.env.example):
  PRESENCE_GATEWAY_URL   full URL of the kiosk-gateway function
  PRESENCE_KIOSK_TOKEN   device token created in Admin -> Kiosk Devices
  PRESENCE_CAMERA_INDEX  camera index (default 0)
  PRESENCE_TOLERANCE     match tolerance, lower = stricter (default 0.45)
  PRESENCE_COOLDOWN_SEC  per-person re-mark cooldown (default 900)
  PRESENCE_SYNC_MIN      gallery re-sync interval in minutes (default 15)
  PRESENCE_SEND_SNAPSHOT 1 to upload a face snapshot with each mark
  PRESENCE_SHOW_WINDOW   1 to show a fullscreen preview window
  PRESENCE_FRAME_WIDTH   processing width (default 640)
"""

from __future__ import annotations

import base64
import json
import os
import queue
import signal
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import face_recognition
import numpy as np
import requests

AGENT_VERSION = "1.0.0"
STATE_DIR = Path(os.environ.get("PRESENCE_STATE_DIR", "/var/lib/presence-kiosk"))
GALLERY_CACHE = STATE_DIR / "gallery.json"
QUEUE_DB = STATE_DIR / "queue.db"

GATEWAY_URL = os.environ.get("PRESENCE_GATEWAY_URL", "").strip()
TOKEN = os.environ.get("PRESENCE_KIOSK_TOKEN", "").strip()
CAMERA_INDEX = int(os.environ.get("PRESENCE_CAMERA_INDEX", "0"))
TOLERANCE = float(os.environ.get("PRESENCE_TOLERANCE", "0.45"))
COOLDOWN_SEC = int(os.environ.get("PRESENCE_COOLDOWN_SEC", "900"))
SYNC_MIN = int(os.environ.get("PRESENCE_SYNC_MIN", "15"))
SEND_SNAPSHOT = os.environ.get("PRESENCE_SEND_SNAPSHOT", "1") == "1"
SHOW_WINDOW = os.environ.get("PRESENCE_SHOW_WINDOW", "1") == "1"
FRAME_WIDTH = int(os.environ.get("PRESENCE_FRAME_WIDTH", "640"))

stop_event = threading.Event()
send_queue: "queue.Queue[dict]" = queue.Queue()
status_lock = threading.Lock()
status = {"device": "Kiosk", "gallery": 0, "online": False, "last": "", "marked_today": 0}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ----------------------------------------------------------------------------- network
def post(action: str, payload: dict | None = None, timeout: int = 30) -> dict:
    body = {"action": action, "agentVersion": AGENT_VERSION}
    if payload:
        body.update(payload)
    resp = requests.post(
        GATEWAY_URL,
        headers={"Content-Type": "application/json", "x-kiosk-token": TOKEN},
        data=json.dumps(body),
        timeout=timeout,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"{resp.status_code}: {resp.text[:300]}")
    return resp.json()


# ----------------------------------------------------------------------------- gallery
class Gallery:
    def __init__(self) -> None:
        self.names: list[str] = []
        self.user_ids: list[str] = []
        self.encodings: np.ndarray = np.zeros((0, 128), dtype=np.float64)
        self.people = 0
        self.cutoff_minutes = 540
        self.device_name = "Kiosk"

    def load(self, data: dict) -> None:
        names, ids, encs = [], [], []
        for entry in data.get("gallery", []):
            for desc in entry.get("descriptors", []):
                if not isinstance(desc, list) or len(desc) != 128:
                    continue
                names.append(entry.get("name") or "Unknown")
                ids.append(entry.get("user_id"))
                encs.append(np.array(desc, dtype=np.float64))
        self.names, self.user_ids = names, ids
        self.encodings = np.vstack(encs) if encs else np.zeros((0, 128), dtype=np.float64)
        self.people = len(data.get("gallery", []))
        self.cutoff_minutes = int(data.get("cutoffMinutes", 540))
        self.device_name = (data.get("device") or {}).get("name") or "Kiosk"

    def match(self, encoding: np.ndarray):
        if not len(self.encodings):
            return None
        dists = np.linalg.norm(self.encodings - encoding, axis=1)
        best = int(np.argmin(dists))
        if dists[best] > TOLERANCE:
            return None
        confidence = float(1.0 / (1.0 + np.exp(14.0 * (dists[best] - TOLERANCE))))
        return {"user_id": self.user_ids[best], "name": self.names[best], "confidence": confidence}


gallery = Gallery()


def sync_gallery() -> bool:
    try:
        data = post("sync", timeout=90)
        gallery.load(data)
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        GALLERY_CACHE.write_text(json.dumps(data))
        with status_lock:
            status["device"] = gallery.device_name
            status["gallery"] = gallery.people
            status["online"] = True
        log(f"Synced gallery: {gallery.people} people / {len(gallery.names)} samples")
        return True
    except Exception as exc:  # offline / bad token
        log(f"Sync failed: {exc}")
        with status_lock:
            status["online"] = False
        if GALLERY_CACHE.exists() and not len(gallery.encodings):
            try:
                gallery.load(json.loads(GALLERY_CACHE.read_text()))
                log(f"Loaded cached gallery: {gallery.people} people")
                with status_lock:
                    status["gallery"] = gallery.people
            except Exception as cache_exc:
                log(f"Cache load failed: {cache_exc}")
        return False


def sync_worker() -> None:
    while not stop_event.is_set():
        if stop_event.wait(SYNC_MIN * 60):
            return
        sync_gallery()


# ----------------------------------------------------------------------------- offline queue
def db() -> sqlite3.Connection:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(QUEUE_DB)
    conn.execute("CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)")
    return conn


def enqueue_offline(event: dict) -> None:
    with db() as conn:
        conn.execute("INSERT INTO pending (payload) VALUES (?)", (json.dumps(event),))


def flush_offline() -> None
    :  # noqa: E999 - placeholder removed below
    pass
