# [REDACTED] — redacted.to

Free redaction tools that run in the browser with local AI models. Built with Middleman.

## Local development

    bundle install
    bundle exec middleman server   # http://localhost:4567
    bundle exec middleman build    # output in build/

## Tools

The landing page grid comes from `data/tools.yml`.

## Deploy (Cloudflare Pages)

- Build command: `bundle exec middleman build`
- Build output directory: `build`
- Ruby version: from `.ruby-version` (or set `RUBY_VERSION` env var)

Or deploy from your machine:

    bundle exec middleman build && npx wrangler pages deploy
