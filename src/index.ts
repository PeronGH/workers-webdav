export default {
	fetch(): Response {
		return new Response('Hello World!');
	},
} satisfies ExportedHandler<Env>;
