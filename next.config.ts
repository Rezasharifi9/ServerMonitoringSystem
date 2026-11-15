import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.NODEGUARD_STANDALONE === "1" ? "standalone" : undefined,
  serverExternalPackages: ["ssh2"],
  outputFileTracingIncludes: {
    "/api/v1/\\[...parts\\]": [
      "./agent/install_agent.py", "./agent/agent_credentials.py", "./agent/nodeguard_agent.py", "./agent/nodeguard_enroll.py",
      "./agent/iperf_worker.py", "./agent/iperf_receiver.py", "./agent/provision_worker.py", "./agent/provision_artifacts.py",
      "./agent/nodeguard-*.service", "./agent/ssh_stage.py", "./agent/build_ssh_bundle.py",
      "./agent/build_service_bundle.py", "./agent/build_tunnel_bundle.py", "./agent/managed_link.py",
      "./agent/gost_forwarding.py",
      "./agent/build_forwarder_bundle.py", "./agent/forwarder_releases.json", "./agent/releases/forwarders/*",
    ],
  },
  // Client-only demo state is hydrated from localStorage. Instant/cache
  // validation drops those segments and blocks in-app navigation.
  turbopack: {
    rules: {
      // Only Tailwind's entrypoint needs this loader. Applying it to CSS
      // modules rewrites their extension and discards the class-name exports.
      "globals.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
