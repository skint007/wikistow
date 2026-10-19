# Install or update the WikiStow CLI, `wikistow`, on Windows, in PowerShell:
#
#   irm https://github.com/skint007/wikistow/releases/latest/download/install.ps1 | iex
#
# It downloads the Windows binary from the latest release, checks it against
# the release's SHA256SUMS, and puts it in %LOCALAPPDATA%\Programs\wikistow,
# adding that to the user's PATH if it's missing. Run it again to update. To
# install another release, set $env:WIKISTOW_RELEASE_URL to its downloads,
# such as https://github.com/skint007/wikistow/releases/download/v0.13.0.
#
# It runs in the caller's session through iex, so it throws rather than exits.

& {
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell's progress bar slows a large download many times over.
  $ProgressPreference = 'SilentlyContinue'
  # Windows PowerShell 5.1 may not offer TLS 1.2, which GitHub requires.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $release = if ($env:WIKISTOW_RELEASE_URL) { $env:WIKISTOW_RELEASE_URL } else { 'https://github.com/skint007/wikistow/releases/latest/download' }
  $dir = Join-Path $env:LOCALAPPDATA 'Programs\wikistow'
  $name = 'wikistow-windows-x64.exe'
  # Windows on Arm runs the x64 binary too.
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'wikistow install: the CLI needs 64-bit Windows.' }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('wikistow-' + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "Downloading $name from $release"
    Invoke-WebRequest -UseBasicParsing -Uri "$release/SHA256SUMS" -OutFile "$tmp\SHA256SUMS"
    Invoke-WebRequest -UseBasicParsing -Uri "$release/$name" -OutFile "$tmp\$name"
    $want = Get-Content "$tmp\SHA256SUMS" | ForEach-Object {
      $hash, $file = -split $_
      if ($file -eq $name) { $hash }
    }
    if (-not $want) { throw "wikistow install: SHA256SUMS has no line for $name." }
    if ((Get-FileHash -Algorithm SHA256 "$tmp\$name").Hash -ne $want) {
      throw "wikistow install: $name doesn't match its checksum in SHA256SUMS."
    }

    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    # Fails while wikistow.exe is running, which Windows doesn't let anyone replace.
    Move-Item -Force "$tmp\$name" "$dir\wikistow.exe"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
  $version = & "$dir\wikistow.exe" --version
  if ($LASTEXITCODE -ne 0) { throw "wikistow install: $dir\wikistow.exe didn't run." }
  Write-Host "Installed $version in $dir"

  # The user's PATH as stored, so entries such as %USERPROFILE%\... stay as
  # they are. .NET's SetEnvironmentVariable would save them expanded.
  $userPath = (Get-Item 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $entries = @("$userPath" -split ';' | Where-Object { $_ })
  if ($entries -notcontains $dir) {
    Set-ItemProperty 'HKCU:\Environment' Path (($entries + $dir) -join ';') -Type ExpandString
    # Any change through .NET tells Explorer to reread the environment, so
    # programs it starts from now on see the new PATH. This clears a variable
    # nobody sets.
    [Environment]::SetEnvironmentVariable('WIKISTOW_INSTALL', $null, 'User')
    Write-Host "Added $dir to your PATH. Open a new terminal to use wikistow."
  }
  # This session too.
  if (($env:Path -split ';') -notcontains $dir) { $env:Path += ";$dir" }
}
