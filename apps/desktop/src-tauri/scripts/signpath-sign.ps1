# Signs a bundled Windows artifact via SignPath (https://signpath.io).
#
# Invoked by the Tauri CLI during `tauri build` because of
# `bundle.windows.signCommand` in tauri.conf.json. The certificate itself is
# held by SignPath and never touches this machine; this script uploads the
# artifact to their API and downloads the signed copy back in place.
#
# Behavior:
#   - SIGNPATH_API_TOKEN not set  -> leave the file unsigned (warn + exit 0)
#     so local/dev builds still work.
#   - SIGNPATH_API_TOKEN set      -> all other variables are required and the
#     build fails if they are missing.
#
# Required environment variables (when signing):
#   SIGNPATH_API_TOKEN               API token of a SignPath CI/submitter user
#   SIGNPATH_ORGANIZATION_ID         GUID of the SignPath organization
#   SIGNPATH_PROJECT_SLUG            project slug, e.g. "key-b0x"
#   SIGNPATH_SIGNING_POLICY_SLUG     e.g. "release-signing"
#
# Optional environment variables:
#   SIGNPATH_ARTIFACT_CONFIGURATION_SLUG  defaults to the project's default
#   SIGNPATH_API_URL                     defaults to https://app.signpath.io/Api/
#   SIGNPATH_DESCRIPTION                 signing request description
#   SIGNPATH_REPOSITORY_URL / SIGNPATH_BRANCH / SIGNPATH_COMMIT_ID /
#   SIGNPATH_BUILD_URL                   filled in automatically in CI when the
#                                        GitHub Actions env vars are present;
#                                        required by SignPath Foundation's
#                                        Open Source Code Signing (origin
#                                        verification)

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath
)

$ErrorActionPreference = 'Stop'

if (-not $env:SIGNPATH_API_TOKEN) {
    Write-Warning "SIGNPATH_API_TOKEN is not set - leaving '$FilePath' UNSIGNED. Set the SignPath variables (see scripts/signpath-sign.ps1) to produce a signed build."
    exit 0
}

# Check the value, not just presence: CI declares these as env: mappings,
# which exist-but-empty when the secret has not been created yet.
foreach ($name in @('SIGNPATH_ORGANIZATION_ID', 'SIGNPATH_PROJECT_SLUG', 'SIGNPATH_SIGNING_POLICY_SLUG')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        throw "SIGNPATH_API_TOKEN is set but $name is missing - refusing to continue."
    }
}

if (-not (Get-Module -ListAvailable -Name SignPath)) {
    # Non-interactive bootstrap (PowerShell Gallery).
    $ProgressPreference = 'SilentlyContinue'
    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
    Install-Module -Name SignPath -Force -Scope CurrentUser -Repository PSGallery -AllowClobber
}
Import-Module SignPath

# Auto-fill origin verification data when running in CI (required by
# SignPath Foundation OSS subscriptions; harmless for regular subscriptions
# unless your project's origin verification is enabled).
if (-not $env:SIGNPATH_REPOSITORY_URL -and $env:GITHUB_REPOSITORY) {
    $env:SIGNPATH_REPOSITORY_URL = "https://github.com/$($env:GITHUB_REPOSITORY)"
    $env:SIGNPATH_BRANCH = $env:GITHUB_REF_NAME
    $env:SIGNPATH_COMMIT_ID = $env:GITHUB_SHA
    $env:SIGNPATH_BUILD_URL = "$($env:GITHUB_SERVER_URL)/$($env:GITHUB_REPOSITORY)/actions/runs/$($env:GITHUB_RUN_ID)"
}

$submitArgs = @{
    InputArtifactPath  = (Resolve-Path $FilePath).Path
    OutputArtifactPath = (Resolve-Path $FilePath).Path
    WaitForCompletion  = $true
    Force              = $true
    OrganizationId     = $env:SIGNPATH_ORGANIZATION_ID
    ApiToken           = $env:SIGNPATH_API_TOKEN
    ProjectSlug        = $env:SIGNPATH_PROJECT_SLUG
    SigningPolicySlug  = $env:SIGNPATH_SIGNING_POLICY_SLUG
}
if ($env:SIGNPATH_ARTIFACT_CONFIGURATION_SLUG) { $submitArgs.ArtifactConfigurationSlug = $env:SIGNPATH_ARTIFACT_CONFIGURATION_SLUG }
if ($env:SIGNPATH_API_URL) { $submitArgs.ApiUrl = $env:SIGNPATH_API_URL }
if ($env:SIGNPATH_DESCRIPTION) { $submitArgs.Description = $env:SIGNPATH_DESCRIPTION }

if ($env:SIGNPATH_REPOSITORY_URL) {
    $repositoryData = @{ SourceControlManagementType = 'git'; Url = $env:SIGNPATH_REPOSITORY_URL }
    if ($env:SIGNPATH_BRANCH) { $repositoryData.BranchName = $env:SIGNPATH_BRANCH }
    if ($env:SIGNPATH_COMMIT_ID) { $repositoryData.CommitId = $env:SIGNPATH_COMMIT_ID }
    $origin = @{ RepositoryData = $repositoryData }
    if ($env:SIGNPATH_BUILD_URL) { $origin.BuildData = @{ Url = $env:SIGNPATH_BUILD_URL } }
    $submitArgs.Origin = $origin
}

Write-Host "Submitting signing request to SignPath for '$FilePath' ..."
Submit-SigningRequest @submitArgs
Write-Host "Signed artifact written back to '$FilePath'."
