<?php
/**
 * WooCommerce blocks registration/account-password submission below this
 * strength score (0=Very Weak .. 4=Strong, default 3). 0 disables enforcement.
 */
add_filter( 'woocommerce_min_password_strength', function () {
	return 0;
} );
