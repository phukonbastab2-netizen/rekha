param([Parameter(Mandatory=$true)][string]$Jdk,[Parameter(Mandatory=$true)][string]$Sdk,[Parameter(Mandatory=$true)][string]$Gradle,[Parameter(Mandatory=$true)][string]$SigningDirectory,[Parameter(Mandatory=$true)][string]$ApkOutput)
$ErrorActionPreference='Stop'
$env:JAVA_HOME=[System.IO.Path]::GetFullPath($Jdk)
$env:ANDROID_HOME=[System.IO.Path]::GetFullPath($Sdk)
$keystore=Join-Path $SigningDirectory 'astrorani-release.jks'
$password=Join-Path $SigningDirectory 'keystore-password.txt'
if(!(Test-Path -LiteralPath $keystore) -or !(Test-Path -LiteralPath $password)){throw 'Existing release signing files are required. Do not generate a different key for an update.'}
function Run-Checked([string]$Executable,[string[]]$Arguments){& $Executable @Arguments;if($LASTEXITCODE -ne 0){throw 'Build or signing step failed.'}}
Run-Checked $Gradle @('-p',$PSScriptRoot,'--no-daemon','--console','plain','assembleRelease')
$unsigned=Join-Path $PSScriptRoot 'build\outputs\apk\release\RekhaAdmin-release-unsigned.apk'
$buildTools=Join-Path $Sdk 'build-tools\35.0.0'
$java=Join-Path $Jdk 'bin\java.exe'
Run-Checked (Join-Path $buildTools 'zipalign.exe') @('-c','-p','4',$unsigned)
Run-Checked $java @('-jar',(Join-Path $buildTools 'lib\apksigner.jar'),'sign','--ks',$keystore,'--ks-key-alias','astrorani','--ks-pass',('file:'+$password),'--out',$ApkOutput,$unsigned)
Run-Checked $java @('-jar',(Join-Path $buildTools 'lib\apksigner.jar'),'verify','--verbose','--print-certs',$ApkOutput)
Get-FileHash -LiteralPath $ApkOutput -Algorithm SHA256
