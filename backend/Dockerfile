FROM python:3.13-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN groupadd --system app && useradd --system --gid app --home /app app

COPY requirements.txt requirements-optional.txt ./
# Upgrade the installer first: the base image's pip has published advisories.
RUN pip install --upgrade "pip>=26.2" && pip install -r requirements.txt -r requirements-optional.txt

COPY alembic ./alembic
COPY app ./app
COPY docker/alembic.ini ./alembic.ini

RUN mkdir -p /app/storage && chown -R app:app /app
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=4).status == 200 else 1)"

# Run migrations explicitly (`alembic upgrade head`) as a release step, then start.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
