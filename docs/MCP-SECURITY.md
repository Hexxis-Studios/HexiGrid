# MCP security boundary

HexiGrid treats every MCP server and every tool it publishes as untrusted. Adding a server stores only its configuration; it remains disabled until the owner checks the connection and reviews every discovered tool.

## Local container servers

Local MCP servers never run directly on the host. They require a digest-pinned OCI image and a working **rootless Podman** installation. HexiGrid verifies that Podman reports rootless mode, verifies that the exact image digest already exists locally, and starts it with image pulls disabled. If Podman, rootless mode, or the pinned image is unavailable, HexiGrid refuses to start the server and leaves it disabled.

Each container runs without a shell, network, Linux capabilities, privilege escalation, or a writable root filesystem. HexiGrid applies process, memory, CPU, output, request, and session limits; uses an unprivileged container user; and provides only a small temporary filesystem. The private workspace is not mounted by default. A user may grant read-only or read/write workspace access explicitly; the mount is limited to HexiGrid's workspace directory. Protected values are loaded from the OS credential vault and passed only to the selected container as named environment variables.

The review identity covers the Podman executable digest, image digest, command, literal arguments, and workspace grant. Any change invalidates the review. Old host-process MCP records are migrated to an invalid, disabled state and must be replaced with a container definition.

## HTTPS servers

Remote MCP servers require HTTPS. Loopback HTTP is allowed only for a service on the same device. Credentials use a protected Bearer value from the OS vault. Redirects, URL credentials, fragments, unsafe ports, oversized responses, private-network resolution by remote hosts, and DNS rebinding to a different address are blocked. The DNS address that passes validation is pinned to the actual socket while TLS still validates the configured hostname.

## Tool review and calls

Discovery validates and bounds the initialization response, tool names, descriptions, and JSON input schemas. HexiGrid records a digest for each normalized tool, the complete tool set, the server identity, and the local launch identity when applicable. Discovery always disables the server.

Before enabling, the owner must assign a capability and risk level to every tool and explicitly mark every tool reviewed. At call time HexiGrid intersects that grant with the active work mode and approval profile. It then re-discovers the complete tool set on the same MCP session, checks every digest, validates the supplied input against the pinned schema, and only then invokes the selected tool. Results are bounded and required to be serializable. Identity or tool drift disables the server, revokes every review, records a failed receipt, and requires a fresh check.

Public browser state contains the reviewed tool metadata, pinned image identity, workspace grant, and status. It never contains container commands, arguments, host paths, server URLs, or credentials. Backups exclude credentials and restore MCP servers disabled.
