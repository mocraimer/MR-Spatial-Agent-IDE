FROM debian:bookworm-slim
LABEL com.spatial.workspace.product="task-environment" com.spatial.workspace.baseline="offline-v1"
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb xdotool scrot xterm mousepad openbox python3 python3-pil dbus-x11 fonts-dejavu-core procps ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 task && useradd -u 1000 -g task -d /home/task -s /bin/bash task \
    && mkdir /workspace && chown task:task /workspace
COPY runtime.py tool.py offline.html /opt/spatial/
USER 1000:1000
ENV HOME=/home/task LANG=C.UTF-8
WORKDIR /workspace
ENTRYPOINT ["python3", "/opt/spatial/runtime.py"]
