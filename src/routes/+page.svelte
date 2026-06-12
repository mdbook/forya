<script lang="ts">
	import Feed from '$lib/components/Feed.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.feed}</title>
	<!-- Per-instance home-screen name (FEED_NAME) for iOS add-to-home-screen. -->
	<meta name="apple-mobile-web-app-title" content={data.feed} />
</svelte:head>

<Feed items={data.items} feedName={data.feed} settings={data.settings} />
