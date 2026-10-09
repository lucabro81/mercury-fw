---
"@mercury-fw/plugin-zitadel": patch
"@mercury-fw/plugin-jira": patch
"@mercury-fw/plugin-bitbucket": patch
---

A person whose login the service revoked (they ended their session, say) is asked to log in again, instead of getting an error until someone logs them out by hand. The pinned CLIs now renew a revoked token, and when that's refused they report it as a login to redo: zitadel 2.6.1, jira 2.3.2, bitbucket 2.3.2.
