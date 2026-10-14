"""Version 1 API. Every module in this package that exposes an ``APIRouter``
named ``router`` (or ``*_router``) is mounted under ``/api/v1``."""

import importlib
import os
import pkgutil

from fastapi import APIRouter


def build_v1_router() -> APIRouter:
    # Optional comma-separated allow-list (development/testing aid only).
    only = {m.strip() for m in os.environ.get("API_MODULES", "").split(",") if m.strip()}
    api = APIRouter(prefix="/api/v1")
    for module_info in sorted(pkgutil.iter_modules(__path__), key=lambda m: m.name):
        if module_info.name.startswith("_"):
            continue
        if only and module_info.name not in only:
            continue
        module = importlib.import_module(f"{__name__}.{module_info.name}")
        for attr in sorted(dir(module)):
            if attr == "router" or attr.endswith("_router"):
                candidate = getattr(module, attr)
                if isinstance(candidate, APIRouter):
                    api.include_router(candidate)
    return api
