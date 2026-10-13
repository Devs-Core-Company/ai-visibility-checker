/**
 * The AVC helper: a single-file WordPress must-use plugin the site owner installs once.
 * It adds a whitelisted REST surface for the fields AVC may change and nothing else:
 *
 * - `avc_seo` REST field on public post types: { title, description, noindex }, mapped to
 *   Yoast SEO, Rank Math or All in One SEO (or stored by the helper when none is active).
 * - `avc_robots_txt` and `avc_llms_txt` settings (manage_options), served at /robots.txt
 *   and /llms.txt when non-empty.
 * - GET /avc/v1/status for detection.
 *
 * Application Passwords (core since WordPress 5.6) authenticate the requests.
 */
export const WP_HELPER_FILENAME = 'avc-helper.php';
export const WP_HELPER_VERSION = '1.0.0';

export const WP_HELPER_PHP = `<?php
/**
 * Plugin Name: AI Visibility Checker helper
 * Description: Lets AI Visibility Checker read and write SEO titles, meta descriptions, noindex, robots.txt and llms.txt through the REST API, with your Application Password. Whitelisted fields only.
 * Version: ${WP_HELPER_VERSION}
 * Author: Devs Core
 * License: MIT
 */

if (!defined('ABSPATH')) {
    exit;
}

function avc_helper_seo_plugin() {
    if (defined('WPSEO_VERSION')) return 'yoast';
    if (class_exists('RankMath')) return 'rank-math';
    if (function_exists('aioseo')) return 'aioseo';
    return 'none';
}

function avc_helper_aioseo_post($id) {
    if (class_exists('\\\\AIOSEO\\\\Plugin\\\\Common\\\\Models\\\\Post')) {
        return \\AIOSEO\\Plugin\\Common\\Models\\Post::getPost($id);
    }
    return null;
}

function avc_helper_get_seo($id) {
    $plugin = avc_helper_seo_plugin();
    if ($plugin === 'yoast') {
        return array(
            'title' => (string) get_post_meta($id, '_yoast_wpseo_title', true),
            'description' => (string) get_post_meta($id, '_yoast_wpseo_metadesc', true),
            'noindex' => get_post_meta($id, '_yoast_wpseo_meta-robots-noindex', true) === '1',
        );
    }
    if ($plugin === 'rank-math') {
        $robots = (array) get_post_meta($id, 'rank_math_robots', true);
        return array(
            'title' => (string) get_post_meta($id, 'rank_math_title', true),
            'description' => (string) get_post_meta($id, 'rank_math_description', true),
            'noindex' => in_array('noindex', $robots, true),
        );
    }
    if ($plugin === 'aioseo') {
        $p = avc_helper_aioseo_post($id);
        if ($p) {
            return array(
                'title' => (string) $p->title,
                'description' => (string) $p->description,
                'noindex' => !$p->robots_default && (bool) $p->robots_noindex,
            );
        }
    }
    return array(
        'title' => (string) get_post_meta($id, '_avc_title', true),
        'description' => (string) get_post_meta($id, '_avc_description', true),
        'noindex' => get_post_meta($id, '_avc_noindex', true) === '1',
    );
}

function avc_helper_set_seo($id, $value) {
    $value = (array) $value;
    $plugin = avc_helper_seo_plugin();
    $title = array_key_exists('title', $value) ? sanitize_text_field((string) $value['title']) : null;
    $desc = array_key_exists('description', $value) ? sanitize_textarea_field((string) $value['description']) : null;
    $noindex = array_key_exists('noindex', $value) ? (bool) $value['noindex'] : null;

    if ($plugin === 'yoast') {
        if ($title !== null) update_post_meta($id, '_yoast_wpseo_title', $title);
        if ($desc !== null) update_post_meta($id, '_yoast_wpseo_metadesc', $desc);
        if ($noindex !== null) update_post_meta($id, '_yoast_wpseo_meta-robots-noindex', $noindex ? '1' : '2');
        return true;
    }
    if ($plugin === 'rank-math') {
        if ($title !== null) update_post_meta($id, 'rank_math_title', $title);
        if ($desc !== null) update_post_meta($id, 'rank_math_description', $desc);
        if ($noindex !== null) {
            $robots = array_values(array_diff((array) get_post_meta($id, 'rank_math_robots', true), array('index', 'noindex')));
            $robots[] = $noindex ? 'noindex' : 'index';
            update_post_meta($id, 'rank_math_robots', $robots);
        }
        return true;
    }
    if ($plugin === 'aioseo') {
        $p = avc_helper_aioseo_post($id);
        if (!$p) return new WP_Error('avc_aioseo', 'All in One SEO post model not available.');
        if (!$p->post_id) $p->post_id = $id;
        if ($title !== null) $p->title = $title;
        if ($desc !== null) $p->description = $desc;
        if ($noindex !== null) {
            $p->robots_default = false;
            $p->robots_noindex = $noindex;
        }
        $p->save();
        return true;
    }
    if ($title !== null) update_post_meta($id, '_avc_title', $title);
    if ($desc !== null) update_post_meta($id, '_avc_description', $desc);
    if ($noindex !== null) update_post_meta($id, '_avc_noindex', $noindex ? '1' : '');
    return true;
}

add_action('rest_api_init', function () {
    register_rest_route('avc/v1', '/status', array(
        'methods' => 'GET',
        'permission_callback' => function () {
            return current_user_can('edit_posts');
        },
        'callback' => function () {
            return array(
                'helper' => '${WP_HELPER_VERSION}',
                'seoPlugin' => avc_helper_seo_plugin(),
                'wordpress' => get_bloginfo('version'),
            );
        },
    ));

    $types = get_post_types(array('public' => true, 'show_in_rest' => true));
    unset($types['attachment']);
    register_rest_field(array_values($types), 'avc_seo', array(
        'get_callback' => function ($obj) {
            if (!current_user_can('edit_post', $obj['id'])) return null;
            return avc_helper_get_seo($obj['id']);
        },
        'update_callback' => function ($value, $post) {
            if (!current_user_can('edit_post', $post->ID)) {
                return new WP_Error('avc_forbidden', 'Not allowed to edit this post.', array('status' => 403));
            }
            return avc_helper_set_seo($post->ID, $value);
        },
        'schema' => array(
            'type' => 'object',
            'context' => array('edit'),
            'properties' => array(
                'title' => array('type' => 'string'),
                'description' => array('type' => 'string'),
                'noindex' => array('type' => 'boolean'),
            ),
        ),
    ));
});

add_action('init', function () {
    foreach (array('avc_robots_txt', 'avc_llms_txt') as $name) {
        register_setting('avc', $name, array(
            'type' => 'string',
            'default' => '',
            'show_in_rest' => true,
            'sanitize_callback' => function ($v) {
                return str_replace("\\r\\n", "\\n", wp_check_invalid_utf8((string) $v));
            },
        ));
    }
});

add_filter('robots_txt', function ($output) {
    $custom = (string) get_option('avc_robots_txt', '');
    return $custom !== '' ? $custom : $output;
}, 99);

add_action('parse_request', function () {
    $path = isset($_SERVER['REQUEST_URI']) ? (string) parse_url((string) $_SERVER['REQUEST_URI'], PHP_URL_PATH) : '';
    if ($path !== '/llms.txt') return;
    $body = (string) get_option('avc_llms_txt', '');
    if ($body === '') return;
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: public, max-age=3600');
    echo $body;
    exit;
}, 0);

// Output for sites without an SEO plugin (fields stored by this helper).
add_filter('pre_get_document_title', function ($title) {
    if (avc_helper_seo_plugin() !== 'none' || !is_singular()) return $title;
    $t = (string) get_post_meta(get_queried_object_id(), '_avc_title', true);
    return $t !== '' ? $t : $title;
}, 20);

add_action('wp_head', function () {
    if (avc_helper_seo_plugin() !== 'none' || !is_singular()) return;
    $d = (string) get_post_meta(get_queried_object_id(), '_avc_description', true);
    if ($d !== '') echo '<meta name="description" content="' . esc_attr($d) . '" />' . "\\n";
}, 1);

add_filter('wp_robots', function ($robots) {
    if (avc_helper_seo_plugin() !== 'none' || !is_singular()) return $robots;
    if (get_post_meta(get_queried_object_id(), '_avc_noindex', true) === '1') $robots['noindex'] = true;
    return $robots;
});
`;

export const WP_HELPER_INSTALL = [
  `Save the file below as \`wp-content/mu-plugins/${WP_HELPER_FILENAME}\` (create the mu-plugins folder if it does not exist). Must-use plugins load automatically.`,
  'Create an Application Password: Users → Profile → Application Passwords → name it "AVC" → copy the password.',
  'Run `avc connect wordpress --url https://your-site --user <username>` and paste the password (or set AVC_WP_APP_PASSWORD).',
  'Remove the file to remove the helper; values it wrote stay in your SEO plugin.',
];
