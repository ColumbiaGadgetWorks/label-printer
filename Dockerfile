FROM python:3.12-alpine

LABEL org.opencontainers.image.title="label-printer" \
      org.opencontainers.image.description="Self-hosted 4x6 label composer with LAN-gated CUPS printing"

# cups-client provides `lp`, used to submit jobs to the remote CUPS server.
RUN apk add --no-cache cups-client

WORKDIR /app
COPY server.py /app/server.py
COPY web/ /app/web/

ENV WEB_ROOT=/app/web \
    PORT=8080 \
    PYTHONUNBUFFERED=1

EXPOSE 8080
USER nobody

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["python", "-u", "/app/server.py"]
