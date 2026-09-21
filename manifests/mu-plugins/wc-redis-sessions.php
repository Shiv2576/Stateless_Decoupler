<?php
/**
 * Plugin Name: WooCommerce Redis Session Store
 * Description: Moves WooCommerce cart/session storage out of MySQL and into Redis.
 *
 * WooCommerce ships WC_Session_Handler, which persists every shopper's cart to
 * the wp_woocommerce_sessions MySQL table. Redis is only consulted as an object
 * cache in front of it, so MySQL remains the authoritative store and absorbs a
 * write on every cart mutation — from every replica, against a single database.
 *
 * WooCommerce exposes a `woocommerce_session_handler` filter for swapping the
 * class outright, so this replaces the storage backend rather than layering a
 * cache over it. Redis becomes authoritative; MySQL is no longer written to for
 * session data at all.
 *
 * Keys are written as `wc_session:<customer_id>` with a TTL matching
 * WooCommerce's own session expiration, which means expiry is handled by Redis
 * instead of WooCommerce's scheduled cleanup job.
 */

defined( 'ABSPATH' ) || exit;

add_filter(
	'woocommerce_session_handler',
	function ( $handler_class ) {
		// The subclass is declared here rather than at file scope because
		// mu-plugins load long before WooCommerce; referencing
		// WC_Session_Handler at file scope would fatal. Touching class_exists()
		// also triggers WooCommerce's autoloader for the parent.
		if ( ! class_exists( 'WC_Session_Handler' ) ) {
			return $handler_class;
		}

		if ( ! class_exists( 'WC_Session_Handler_Redis', false ) ) {
			/**
			 * Redis-backed WooCommerce session store.
			 *
			 * Every method degrades to the stock MySQL implementation if Redis
			 * is unreachable. Losing Redis should mean slower carts, not a
			 * store that cannot take orders.
			 */
			class WC_Session_Handler_Redis extends WC_Session_Handler {

				/** @var Redis|null Connected client, or null if unavailable. */
				private $redis = null;

				/** @var bool Set once a connection attempt has failed this request. */
				private $unavailable = false;

				/**
				 * Lazily open a connection, at most once per request.
				 *
				 * @return Redis|null
				 */
				private function redis() {
					if ( null !== $this->redis || $this->unavailable ) {
						return $this->redis;
					}

					if ( ! class_exists( 'Redis' ) ) {
						$this->unavailable = true;
						return null;
					}

					$host    = defined( 'WP_REDIS_HOST' ) ? WP_REDIS_HOST : '127.0.0.1';
					$port    = defined( 'WP_REDIS_PORT' ) ? (int) WP_REDIS_PORT : 6379;
					$timeout = defined( 'WP_REDIS_TIMEOUT' ) ? (float) WP_REDIS_TIMEOUT : 1.0;

					try {
						$client = new Redis();
						// pconnect keeps the socket open across requests handled
						// by the same PHP-FPM worker. Without it every cart
						// operation pays a fresh TCP handshake.
						if ( ! $client->pconnect( $host, $port, $timeout ) ) {
							$this->unavailable = true;
							return null;
						}
						$this->redis = $client;
					} catch ( Throwable $e ) {
						$this->unavailable = true;
						$this->redis       = null;
					}

					return $this->redis;
				}

				/**
				 * @param string $customer_id Customer ID.
				 * @return string
				 */
				private function key( $customer_id ) {
					return 'wc_session:' . $customer_id;
				}

				/**
				 * @param string $customer_id Customer ID.
				 * @param mixed  $default     Value to return when no session exists.
				 * @return string|array
				 */
				public function get_session( $customer_id, $default = false ) {
					$redis = $this->redis();
					if ( ! $redis ) {
						return parent::get_session( $customer_id, $default );
					}

					try {
						$value = $redis->get( $this->key( $customer_id ) );
					} catch ( Throwable $e ) {
						return parent::get_session( $customer_id, $default );
					}

					if ( false === $value ) {
						return $default;
					}

					return maybe_unserialize( $value );
				}

				/**
				 * @param int $old_session_key Session ID held before the user logged in.
				 */
				public function save_data( $old_session_key = 0 ) {
					$redis = $this->redis();
					if ( ! $redis ) {
						parent::save_data( $old_session_key );
						return;
					}

					if ( ! $this->_dirty || ! $this->has_session() ) {
						return;
					}

					// Expiration is an absolute timestamp; Redis wants a
					// relative TTL. Never allow a non-positive value, which
					// phpredis would reject.
					$ttl = max( 1, (int) $this->_session_expiration - time() );

					try {
						$redis->setex(
							$this->key( $this->_customer_id ),
							$ttl,
							maybe_serialize( $this->_data )
						);
					} catch ( Throwable $e ) {
						parent::save_data( $old_session_key );
						return;
					}

					$this->_dirty = false;

					// Mirrors core: once a guest logs in, their pre-login
					// session is merged and the old key must be discarded.
					if ( get_current_user_id() != $old_session_key && ! is_object( get_user_by( 'id', $old_session_key ) ) ) {
						$this->delete_session( $old_session_key );
					}
				}

				/**
				 * @param int $customer_id Customer ID.
				 */
				public function delete_session( $customer_id ) {
					$redis = $this->redis();
					if ( ! $redis ) {
						parent::delete_session( $customer_id );
						return;
					}

					try {
						$redis->del( $this->key( $customer_id ) );
					} catch ( Throwable $e ) {
						parent::delete_session( $customer_id );
					}
				}

				/**
				 * @param string $customer_id Customer ID.
				 * @param int    $timestamp   Absolute expiry timestamp.
				 */
				public function update_session_timestamp( $customer_id, $timestamp ) {
					$redis = $this->redis();
					if ( ! $redis ) {
						parent::update_session_timestamp( $customer_id, $timestamp );
						return;
					}

					try {
						$redis->expireAt( $this->key( $customer_id ), (int) $timestamp );
					} catch ( Throwable $e ) {
						parent::update_session_timestamp( $customer_id, $timestamp );
					}
				}

				/**
				 * Redis evicts expired keys itself, so WooCommerce's scheduled
				 * cleanup has nothing to sweep. Only fall through to the MySQL
				 * sweep when Redis is not in play.
				 */
				public function cleanup_sessions() {
					if ( ! $this->redis() ) {
						parent::cleanup_sessions();
					}
				}
			}
		}

		return 'WC_Session_Handler_Redis';
	}
);
