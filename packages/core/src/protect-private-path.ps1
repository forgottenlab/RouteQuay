param([Parameter(Mandatory = $true)][string]$LiteralPath, [switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
try {
$stage = 'acl-apply'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if (Test-Path -LiteralPath $LiteralPath -PathType Container) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
} else {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
}
# Keep the existing owner. Writing ownership requests WRITE_OWNER, which can
# fail in a restricted Node child even when changing the DACL is permitted.
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule($rule)
if (Test-Path -LiteralPath $LiteralPath -PathType Container) {
    $item = [System.IO.DirectoryInfo]::new($LiteralPath)
} else {
    $item = [System.IO.FileInfo]::new($LiteralPath)
}
if (-not $VerifyOnly) { $item.SetAccessControl($acl) }
$stage = 'acl-verify'
$actual = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$currentUserFullControl = $false
if (-not $actual.AreAccessRulesProtected -or $rules.Count -eq 0) { throw 'ACL_VERIFY_FAILED' }
foreach ($entry in $rules) {
    if ($entry.IsInherited -or $entry.AccessControlType -ne 'Allow' -or $entry.IdentityReference.Value -ne $identity.Value) {
        throw 'ACL_VERIFY_FAILED'
    }
    if (($entry.FileSystemRights -band $full) -eq $full) { $currentUserFullControl = $true }
}
if (-not $currentUserFullControl) { throw 'ACL_VERIFY_FAILED' }
ConvertTo-Json -Compress @{ ok = $true; stage = 'acl-verified'; ruleCount = $rules.Count }
} catch {
    # Exception messages and paths are intentionally excluded from CLI diagnostics.
    ConvertTo-Json -Compress @{ ok = $false; stage = $stage; errorType = $_.Exception.GetType().FullName; hresult = $_.Exception.HResult }
    exit 1
}
