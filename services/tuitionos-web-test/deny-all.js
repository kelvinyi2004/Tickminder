export default {
  async fetch(request, env) {
    return new Response(JSON.stringify({
      error: "Access Denied: Staging Maintenance Lock Active",
      service: "tuitionos-web-test",
      status: "deny-all-maintenance"
    }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
};
