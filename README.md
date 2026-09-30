# [REDACTED] — redacted.to

Free redaction tools that run in the browser with local AI models. Built with Middleman.

## Local development

    bundle install
    bundle exec middleman server   # http://localhost:4567
    bundle exec middleman build    # output in build/

## Tools

The landing page grid comes from `data/tools.yml`.

## Deploy (Cloudflare Workers)

The output directory is set in `wrangler.toml` (`assets.directory = "./build"`).

In the Cloudflare dashboard (Workers & Pages → Create → Import a repository):

- Build command: `bundle exec middleman build`
- Deploy command: `npx wrangler deploy`
- The Worker name must match `name` in `wrangler.toml` (`redacted-site`)

Or deploy from your machine:

    bundle exec middleman build && npx wrangler deploy
