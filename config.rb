# Site settings
set :site_name, "[REDACTED]"
set :site_url, "https://redacted.to"
set :site_description, "Free redaction tools that run entirely in your browser. Local AI models. Nothing leaves your device."
set :newsletter_url, "https://mailchi.mp/52e24e1cbb61/redacted-mailing-list"

activate :directory_indexes

page "/*.xml", layout: false
page "/*.json", layout: false
page "/*.txt", layout: false

# Cloudflare Pages reads _headers from the build root.
# Middleman ignores files that start with "_", so import it explicitly.
import_file File.expand_path("_headers", config[:source]), "/_headers"

# A "coming soon" page for each tool that is not live yet.
data.tools.each do |tool|
  next if tool.live
  proxy "/tools/#{tool.slug}/index.html", "/tools/coming-soon.html",
        locals: { tool: tool },
        data: { title: tool.name, description: "#{tool.description} Coming soon to redacted.to: free, in your browser, no uploads." },
        ignore: true
end

configure :build do
  # Tool scripts load each other and a worker by relative URL, so keep their names.
  activate :asset_hash, ignore: [%r{^javascripts/tools/}, %r{^samples/}], rewrite_ignore: [%r{^/?javascripts/tools/}]
  activate :minify_css
end
