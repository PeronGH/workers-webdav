# workers-webdav

A multi-user WebDAV server on Cloudflare Workers, storing files in R2.

Each user is confined to their own `<username>/` prefix in the bucket, and keys mirror paths one-to-one, so the bucket can also be managed with any S3 tool. Passwords are derived from the username and a server secret, so there is no user database: the admin mints as many users as they like.

Locks are stateless, so nothing besides R2 is needed: `LOCK` always succeeds, and a save under a lock fails with `412` if someone else changed the file since. This keeps clients that lock from overwriting each other's changes, but a client that does not lock can still overwrite a locked file.

Uploads are capped by Cloudflare's request body limit (100 MB on the Free and Pro plans), and copying or moving a folder takes two R2 operations per file, within the Worker's subrequest limit.

## Deploy

```sh
bun install
bunx wrangler r2 bucket create workers-webdav
openssl rand -base64 32 | bunx wrangler secret put AUTH_SECRET
bun run deploy
```

## Add users

Usernames are lowercase letters, digits, `-` and `_`, up to 32 characters.

```sh
AUTH_SECRET=<secret> bun run mint alice bob
```

This prints each username with its password. Rotating `AUTH_SECRET` changes every user's password at once.

## Connect

Use the Worker URL with the minted username and password, for example with rclone:

```sh
rclone lsf --webdav-url https://webdav.<account>.workers.dev \
  --webdav-user alice --webdav-pass "$(rclone obscure <password>)" :webdav:
```

In macOS Finder, use **Go › Connect to Server**; in Windows Explorer, use **Map network drive**.

## Develop

Put `AUTH_SECRET=<anything>` in `.dev.vars`, then:

```sh
bun run dev
bun run test
```
