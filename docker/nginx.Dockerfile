# Ingress sidecar image: stock unprivileged nginx + our server block.
#
# The base already runs as a non-root user with pid/temp/log paths configured,
# so there is nothing to harden here — we only drop in the server block (it
# replaces the base image's sample default.conf).
FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
