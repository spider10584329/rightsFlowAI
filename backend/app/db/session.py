from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings

DATABASE_URL = settings.database_url

# Strict mode makes MariaDB reject (instead of silently truncating/clamping)
# out-of-range DECIMALs, over-long strings and NULLs in NOT NULL columns, so a
# server configured non-strict (e.g. XAMPP's my.ini) can't corrupt financial data.
STRICT_SQL_MODE = (
    "STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_IN_DATE,NO_ZERO_DATE,"
    "NO_ENGINE_SUBSTITUTION"
)
CONNECT_ARGS = {
    "init_command": f"SET SESSION sql_mode='{STRICT_SQL_MODE}', time_zone='+00:00'",
    "charset": "utf8mb4",
}

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=1800,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    connect_args=CONNECT_ARGS,
    # READ COMMITTED: plain reads after a SELECT ... FOR UPDATE see the latest
    # committed rows (REPEATABLE READ would reuse the snapshot taken by the
    # auth dependency, making lock-protected balance checks read stale data).
    isolation_level="READ COMMITTED",
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    expire_on_commit=False,
)


def get_db() -> Iterator[Session]:
    with SessionLocal() as db:
        yield db
