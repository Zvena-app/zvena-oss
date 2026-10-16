# Security policy

## Reporting a vulnerability

Please do **not** open a public issue. E-mail **hi@zvena.app** with the subject "Security".

Include what is affected (a part of the code in this repository or an app in `clients/`, and the version), the steps to reproduce, and the impact you expect. We will acknowledge your report, keep you informed while we fix it, and credit you if you wish. Please give us reasonable time to fix the problem before you disclose it, and do not access other people's data, degrade a service or run automated scanners against servers you do not run while testing.

## Scope

- In scope: the code in this repository. Servers that run zvena are their operators' responsibility; report problems in the code to us.
- zvena Design is a fork of Penpot. If a vulnerability also affects upstream Penpot, report it to Penpot as well (<https://github.com/penpot/penpot/security>); we will coordinate.
- Out of scope: findings that need a compromised device or browser, social engineering, denial of service, and reports from automated tools without a demonstrated impact.

## Supported versions

The latest release and the latest commit of `main` are supported. If you run your own server, keep it up to date with `main`.

This project has no bug bounty program.
