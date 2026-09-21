<?php
/**
 * Seeds demo products into WooCommerce. Run via wp-cli:
 *   wp eval-file seed-store.php --allow-root
 *
 * Product images are generated in-process with GD and pushed through
 * WordPress's normal upload pipeline, which means they travel via the
 * s3-uploads plugin into MinIO rather than onto the pod's disk. Seeding the
 * store therefore also exercises the media-decoupling path.
 *
 * Idempotent: products are matched by slug and skipped if already present, so
 * this can be re-run safely from the dashboard.
 */

if ( ! class_exists( 'WooCommerce' ) ) {
	WP_CLI::error( 'WooCommerce is not active.' );
}

require_once ABSPATH . 'wp-admin/includes/media.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/image.php';

$catalogue = array(
	array( 'name' => 'Aurora Desk Lamp',      'price' => '48.00',  'rgb' => array( 38, 78, 121 ),  'desc' => 'Warm dimmable LED desk lamp with a brushed aluminium arm.' ),
	array( 'name' => 'Nomad Canvas Backpack', 'price' => '89.50',  'rgb' => array( 122, 86, 52 ),  'desc' => 'Water-resistant 24L canvas backpack with a padded laptop sleeve.' ),
	array( 'name' => 'Terra Ceramic Mug',     'price' => '18.00',  'rgb' => array( 154, 78, 62 ),  'desc' => 'Hand-glazed stoneware mug, 350ml, dishwasher safe.' ),
	array( 'name' => 'Drift Wireless Buds',   'price' => '129.00', 'rgb' => array( 46, 125, 79 ),  'desc' => 'Active noise cancelling earbuds with 28 hours of battery life.' ),
	array( 'name' => 'Kiln Pour-Over Set',    'price' => '64.00',  'rgb' => array( 88, 66, 120 ),  'desc' => 'Borosilicate carafe and ceramic dripper for single-origin coffee.' ),
	array( 'name' => 'Field Notebook Trio',   'price' => '22.50',  'rgb' => array( 176, 122, 34 ), 'desc' => 'Three 48-page dot-grid notebooks with stitched spines.' ),
);

/**
 * Build a simple product tile and attach it to the media library.
 *
 * @return int Attachment ID, or 0 if the image could not be created.
 */
function sd_make_product_image( $name, array $rgb ) {
	if ( ! function_exists( 'imagecreatetruecolor' ) ) {
		return 0;
	}

	// Drawn small and scaled up: GD's built-in bitmap fonts top out at a size
	// that is unreadable on a 600px tile, so the text is rendered at native
	// size and enlarged with the rest of the canvas.
	$small = imagecreatetruecolor( 200, 200 );
	$bg    = imagecolorallocate( $small, $rgb[0], $rgb[1], $rgb[2] );
	$fg    = imagecolorallocate( $small, 255, 255, 255 );
	imagefilledrectangle( $small, 0, 0, 200, 200, $bg );

	$words = explode( ' ', $name );
	$line  = 0;
	foreach ( $words as $word ) {
		$x = max( 4, (int) ( ( 200 - ( strlen( $word ) * 9 ) ) / 2 ) );
		imagestring( $small, 5, $x, 70 + ( $line * 18 ), $word, $fg );
		$line++;
	}

	$large = imagescale( $small, 600, 600, IMG_NEAREST_NEIGHBOUR );
	imagedestroy( $small );
	if ( ! $large ) {
		return 0;
	}

	$tmp = wp_tempnam( sanitize_title( $name ) . '.png' );
	imagepng( $large, $tmp );
	imagedestroy( $large );

	$attachment_id = media_handle_sideload(
		array(
			'name'     => sanitize_title( $name ) . '.png',
			'tmp_name' => $tmp,
		),
		0
	);

	if ( is_wp_error( $attachment_id ) ) {
		// A failed image must not block the product itself — the store is still
		// demonstrable without a picture.
		@unlink( $tmp );
		WP_CLI::warning( "Image failed for {$name}: " . $attachment_id->get_error_message() );
		return 0;
	}

	return (int) $attachment_id;
}

$created = 0;
$skipped = 0;

foreach ( $catalogue as $item ) {
	$slug = sanitize_title( $item['name'] );

	if ( get_page_by_path( $slug, OBJECT, 'product' ) ) {
		$skipped++;
		continue;
	}

	$product = new WC_Product_Simple();
	$product->set_name( $item['name'] );
	$product->set_slug( $slug );
	$product->set_status( 'publish' );
	$product->set_catalog_visibility( 'visible' );
	$product->set_regular_price( $item['price'] );
	$product->set_description( $item['desc'] );
	$product->set_short_description( $item['desc'] );
	$product->set_manage_stock( false );
	$product->set_stock_status( 'instock' );
	$product_id = $product->save();

	$image_id = sd_make_product_image( $item['name'], $item['rgb'] );
	if ( $image_id ) {
		$product->set_image_id( $image_id );
		$product->save();
	}

	$created++;
	WP_CLI::log( "created: {$item['name']} (#{$product_id})" );
}

// Front page defaults to the "Sample Page"/blog on a fresh install, which makes
// the store look empty even once products exist. Point it at the shop archive.
$shop_page_id = wc_get_page_id( 'shop' );
if ( $shop_page_id > 0 ) {
	update_option( 'show_on_front', 'page' );
	update_option( 'page_on_front', $shop_page_id );
}

WP_CLI::success( "seeded: {$created} created, {$skipped} already present" );
