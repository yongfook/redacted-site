# Site settings
set :site_name, "[REDACTED]"
set :site_url, "https://redacted.to"
set :site_description, "Free redaction tools that run entirely in your browser. Local AI models. Nothing leaves your device."

activate :directory_indexes

page "/*.xml", layout: false
page "/*.json", layout: false
page "/*.txt", layout: false

# Cloudflare Pages reads _headers from the build root.
# Middleman ignores files that start with "_", so import it explicitly.
import_file File.expand_path("_headers", config[:source]), "/_headers"

configure :build do
  activate :asset_hash
  activate :minify_css
end
