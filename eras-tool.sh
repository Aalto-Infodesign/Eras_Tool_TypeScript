#!/bin/bash

source /etc/sandbox/env
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock

notify-send 'ERAS Tool' 'We are starting your application. This could take up to 1min. Browser will be started automatically when ready.'

# update images
docker pull europe-docker.pkg.dev/finngen-sandbox-v3-containers/eu.gcr.io/eras-tool:latest

# run
docker run --log-driver syslog --rm -d -p 8566:80 \
  europe-docker.pkg.dev/finngen-sandbox-v3-containers/eu.gcr.io/eras-tool:latest

# wait until the ERAS Tool is ready
echo "Waiting for ERAS Tool to be ready, may take few seconds"
counter=0
until [ "$(curl -s -o /dev/null -I -w '%{http_code}' "http://localhost:8566")" -eq 200 ]
do
    sleep 1
    ((counter++))
    echo -ne "Waiting for ERAS Tool to be ready (${counter}s) \r"
done

# open the ERAS tool in the browser
firefox --new-tab "http://localhost:8566"

echo "if the eras tool does not launch automatically, visit: http://localhost:8566"