from logging.config import fileConfig
from pathlib import Path
import sys

from alembic import context
from sqlalchemy import create_engine, pool

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from app.db.session import DATABASE_URL  # noqa: E402
from app.db.base import Base  # noqa: E402
import app.models  # noqa: E402,F401  (registers every table on Base.metadata)

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

# Allow `alembic -x db_url=...` to target another database (e.g. the test DB).
DB_URL = context.get_x_argument(as_dictionary=True).get("db_url", DATABASE_URL)


def run_migrations_offline():
    context.configure(
        url=DB_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    from app.db.session import CONNECT_ARGS

    connectable = create_engine(DB_URL, poolclass=pool.NullPool, connect_args=CONNECT_ARGS)

    try:
        with connectable.connect() as connection:
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                compare_type=True,
            )

            with context.begin_transaction():
                context.run_migrations()
    finally:
        connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
