# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/prithvirajmody/Meridian/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it, and the
commit you tested.

Meridian is maintained by one person, so there is no guaranteed response time.

## Scope

Meridian runs locally. The parts that handle untrusted input are the domain
adapters, which parse the files you open; the graph-document decoder; and the
Studio, which renders those graphs in the browser. Reports about any of them
are in scope, as are problems in the CI workflow.

The `meridian ai` commands default to a mock provider and can replay recorded
fixtures; neither makes network calls. Live mode sends document text to the
provider you configure, and only runs with `--ai-consent`.
