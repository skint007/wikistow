# The Homebrew cask for the desktop app, published to the skint007/wikistow
# tap (github.com/skint007/homebrew-wikistow) by .github/workflows/homebrew.yml,
# which fills in the release's version and checksums:
#
#   brew install --cask skint007/wikistow/wikistow
cask "wikistow" do
  arch arm: "arm64", intel: "x64"

  version "@VERSION@"
  sha256 arm:   "@SHA256_ARM64@",
         intel: "@SHA256_X64@"

  url "https://github.com/skint007/wikistow/releases/download/v#{version}/wikistow-desktop-#{version}-macos-#{arch}.zip"
  name "WikiStow"
  desc "Encrypted wiki for family and friends"
  homepage "https://github.com/skint007/wikistow"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

  app "WikiStow.app"

  # The web clipper's host manifests, which the app writes at each launch
  # for the browsers it finds (docs/desktop.md). They name the app's helper,
  # so they go with it; they aren't the person's data.
  uninstall delete: [
    "~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/io.github.skint007.wikistow.json",
    "~/Library/Application Support/Chromium/NativeMessagingHosts/io.github.skint007.wikistow.json",
    "~/Library/Application Support/Google/Chrome/NativeMessagingHosts/io.github.skint007.wikistow.json",
    "~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/io.github.skint007.wikistow.json",
    "~/Library/Application Support/Mozilla/NativeMessagingHosts/io.github.skint007.wikistow.json",
  ]

  zap trash: [
    "~/Library/Application Support/WikiStow",
    "~/Library/Preferences/io.github.skint007.wikistow.plist",
    "~/Library/Saved Application State/io.github.skint007.wikistow.savedState",
  ]
end
