# Security policy

## Supported versions

Only the latest release receives security fixes. Upgrade before you report an issue, because older versions may still be affected.

## Report a vulnerability

Report vulnerabilities privately through [GitHub's vulnerability reporting form](https://github.com/leocavalcante/pi-otel/security/advisories/new). Don't open a public issue, discussion, or pull request for them.

Include:

- the affected version, your Pi and Node.js versions, and your operating system
- what an attacker can do, and the steps to reproduce it, when it's safe to share them

Leave out credentials, tokens, collector endpoints that embed secrets, prompts, session data, and project files. Use synthetic or redacted examples instead.

Please give the maintainer time to investigate and release a fix before you disclose the issue publicly.

## Exposed credentials

If a credential was exposed, revoke or rotate it with its provider first, then report how it was exposed. Never include the credential itself.
