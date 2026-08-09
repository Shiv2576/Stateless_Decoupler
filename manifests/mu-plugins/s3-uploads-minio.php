<?php
/**
 * humanmade/s3-uploads has no built-in support for custom S3-compatible
 * endpoints (only real AWS S3), so this points its AWS SDK client at MinIO
 * via the one filter it does expose.
 */

add_filter( 's3_uploads_s3_client_params', function ( $params ) {
	if ( defined( 'S3_UPLOADS_ENDPOINT' ) && S3_UPLOADS_ENDPOINT ) {
		$params['endpoint'] = S3_UPLOADS_ENDPOINT;
		$params['use_path_style_endpoint'] = ! defined( 'S3_UPLOADS_USE_PATH_STYLE_ENDPOINT' )
			|| S3_UPLOADS_USE_PATH_STYLE_ENDPOINT;
	}
	return $params;
} );
