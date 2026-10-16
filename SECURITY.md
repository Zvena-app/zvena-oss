# Security policy

## Reporting a vulnerability

Please do **not** open a public issue. E-mail **hi@zvena.app** with the subject "Security", or use the contact in <https://zvena.app/.well-known/security.txt>.

Include what is affected (zvena.app, Design at design.zvena.app, the code in this repository, an app in `clients/`), the steps to reproduce, and the impact you expect. We will acknowledge your report, keep you informed while we fix it, and credit you if you wish. Please give us reasonable time to fix the problem before you disclose it, and do not access other people's data, degrade the service or run automated scanners against production while testing.

## Scope

- In scope: zvena.app and its subdomains, the code in this repository. Servers run by other people are their operators' responsibility; report problems in the code to us.
- zvena Design is a fork of Penpot. If a vulnerability also affects upstream Penpot, report it to Penpot as well (<https://github.com/penpot/penpot/security>); we will coordinate.
- Out of scope: findings that need a compromised device or browser, social engineering, denial of service, and reports from automated tools without a demonstrated impact.

## Supported versions

The version running on zvena.app and the latest commit of `main` are supported. If you run your own server, keep it up to date with `main`.

This project has no bug bounty program.
