FROM composer:2 AS composer-bin

FROM wordpress:6.6-php8.2-fpm-alpine

# wp-cli is only used at runtime (to activate plugins against the real DB),
# not during this build — `wp plugin install`/`wp redis enable` fully
# bootstrap WordPress and need a live DB connection, which isn't available
# in a build step.
RUN apk add --no-cache bash less mysql-client unzip \
  && curl -o /usr/local/bin/wp -fsSL https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
  && chmod +x /usr/local/bin/wp

# The redis-cache WP plugin and wp-config.php's session.save_handler ini_set
# both need the actual PHP redis extension (phpredis) — without it,
# ini_set('session.save_handler', 'redis') silently fails and PHP falls back
# to 'files', defeating stateless sessions.
RUN apk add --no-cache --virtual .build-deps $PHPIZE_DEPS \
  && curl -fsSL -o /tmp/phpredis.tar.gz https://github.com/phpredis/phpredis/archive/refs/tags/6.3.0.tar.gz \
  && mkdir -p /tmp/phpredis \
  && tar -xzf /tmp/phpredis.tar.gz -C /tmp/phpredis --strip-components=1 \
  && ( cd /tmp/phpredis && phpize && ./configure && make -j"$(nproc)" && make install ) \
  && docker-php-ext-enable redis \
  && rm -rf /tmp/phpredis /tmp/phpredis.tar.gz \
  && apk del .build-deps

COPY --from=composer-bin /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

# The base image only copies WP core into /var/www/html at container startup
# (docker-entrypoint.sh, if the dir is empty). Do it now too so the runtime
# entrypoint has nothing left to do (dir won't be empty).
RUN cp -a /usr/src/wordpress/. /var/www/html/

# Plugin files, fetched directly (no DB needed). Activation is DB state
# (wp_options), shared via MySQL across all replicas, so it happens once at
# deploy time instead.
# WooCommerce is pinned to 9.5.0 (not latest-stable) since newer releases
# require WP 6.9+ and this base image is pinned to WP 6.6.
RUN curl -fsSL -o /tmp/redis-cache.zip https://downloads.wordpress.org/plugin/redis-cache.latest-stable.zip \
  && curl -fsSL -o /tmp/woocommerce.zip https://downloads.wordpress.org/plugin/woocommerce.9.5.0.zip \
  && unzip -q /tmp/redis-cache.zip -d wp-content/plugins/ \
  && unzip -q /tmp/woocommerce.zip -d wp-content/plugins/ \
  && rm /tmp/redis-cache.zip /tmp/woocommerce.zip \
  && cp wp-content/plugins/redis-cache/includes/object-cache.php wp-content/object-cache.php

# humanmade/s3-uploads isn't on wordpress.org and needs Composer to pull in
# the AWS SDK. composer/installers (a transitive dep) places it under
# wp-content/plugins/s3-uploads, same as any other plugin. Unlike
# amazon-s3-and-cloudfront (WP Offload Media), this one supports pointing
# at a custom S3-compatible endpoint like MinIO (via the mu-plugin below).
RUN composer init --no-interaction --working-dir=/var/www/html --name="stateless/wordpress" --type=project \
  && composer config --working-dir=/var/www/html allow-plugins.composer/installers true \
  && composer require humanmade/s3-uploads:^3.0 --no-interaction --working-dir=/var/www/html

COPY mu-plugins/s3-uploads-minio.php wp-content/mu-plugins/s3-uploads-minio.php
COPY mu-plugins/disable-password-strength.php wp-content/mu-plugins/disable-password-strength.php

RUN chown -R www-data:www-data wp-content vendor composer.json composer.lock

# Exposes PHP-FPM's built-in status page (active/idle workers, max children
# reached) for the k6 dashboard to read per-pod concurrency — paired with the
# /fpm-status nginx location in wordpress-config.yaml.
RUN echo "pm.status_path = /status" >> /usr/local/etc/php-fpm.d/www.conf
