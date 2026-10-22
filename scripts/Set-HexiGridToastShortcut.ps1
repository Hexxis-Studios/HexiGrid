[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ShortcutPath,
  [Parameter(Mandatory)][string]$AppUserModelId,
  [Parameter(Mandatory)][guid]$ToastActivatorClsid,
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) { throw 'Create the HexiGrid Start Menu shortcut before assigning notification identity.' }

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[StructLayout(LayoutKind.Sequential)]
internal struct HexiGridPropertyKey
{
    public Guid FormatId;
    public uint PropertyId;
    public HexiGridPropertyKey(Guid formatId, uint propertyId) { FormatId = formatId; PropertyId = propertyId; }
}

[StructLayout(LayoutKind.Sequential)]
internal struct HexiGridPropVariant
{
    public ushort Type;
    public ushort Reserved1;
    public ushort Reserved2;
    public ushort Reserved3;
    public IntPtr PointerValue;
}

[ComImport, Guid("00021401-0000-0000-C000-000000000046"), ClassInterface(ClassInterfaceType.None)]
internal class HexiGridShellLink { }

[ComImport, Guid("0000010B-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface HexiGridPersistFile
{
    void GetClassID(out Guid classId);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, int mode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, [MarshalAs(UnmanagedType.Bool)] bool remember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface HexiGridPropertyStore
{
    void GetCount(out uint count);
    void GetAt(uint index, out HexiGridPropertyKey key);
    void GetValue(ref HexiGridPropertyKey key, out HexiGridPropVariant value);
    void SetValue(ref HexiGridPropertyKey key, ref HexiGridPropVariant value);
    void Commit();
}

public static class HexiGridToastShortcut
{
    private static readonly Guid AppModelKey = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    private static readonly HexiGridPropertyKey AppUserModelIdKey = new HexiGridPropertyKey(AppModelKey, 5);
    private static readonly HexiGridPropertyKey ToastActivatorKey = new HexiGridPropertyKey(AppModelKey, 26);

    [DllImport("ole32.dll", EntryPoint = "PropVariantClear")]
    private static extern int Clear(ref HexiGridPropVariant value);

    public static void SetAndVerify(string path, string appId, string clsidText)
    {
        Guid clsid = Guid.Parse(clsidText);
        object comObject = new HexiGridShellLink();
        try
        {
            HexiGridPersistFile file = (HexiGridPersistFile)comObject;
            file.Load(path, 2);
            HexiGridPropertyStore store = (HexiGridPropertyStore)comObject;
            SetString(store, AppUserModelIdKey, appId);
            SetGuid(store, ToastActivatorKey, clsid);
            store.Commit();
            file.Save(path, true);
            VerifyValues(store, appId, clsid);
        }
        finally { if (Marshal.IsComObject(comObject)) Marshal.FinalReleaseComObject(comObject); }
    }

    public static void VerifyOnly(string path, string appId, string clsidText)
    {
        Guid clsid = Guid.Parse(clsidText);
        object comObject = new HexiGridShellLink();
        try
        {
            HexiGridPersistFile file = (HexiGridPersistFile)comObject;
            file.Load(path, 2);
            VerifyValues((HexiGridPropertyStore)comObject, appId, clsid);
        }
        finally { if (Marshal.IsComObject(comObject)) Marshal.FinalReleaseComObject(comObject); }
    }

    private static void VerifyValues(HexiGridPropertyStore store, string appId, Guid clsid)
    {
        if (!String.Equals(ReadString(store, AppUserModelIdKey), appId, StringComparison.Ordinal))
            throw new InvalidOperationException("The Start Menu shortcut did not retain HexiGrid's AppUserModelID.");
        if (ReadGuid(store, ToastActivatorKey) != clsid)
            throw new InvalidOperationException("The Start Menu shortcut did not retain the SnoreToast activator CLSID.");
    }

    private static void SetString(HexiGridPropertyStore store, HexiGridPropertyKey key, string text)
    {
        HexiGridPropVariant value = new HexiGridPropVariant { Type = 31, PointerValue = Marshal.StringToCoTaskMemUni(text) };
        try { store.SetValue(ref key, ref value); }
        finally { Clear(ref value); }
    }

    private static void SetGuid(HexiGridPropertyStore store, HexiGridPropertyKey key, Guid guid)
    {
        IntPtr valuePointer = Marshal.AllocCoTaskMem(Marshal.SizeOf<Guid>());
        Marshal.StructureToPtr(guid, valuePointer, false);
        HexiGridPropVariant value = new HexiGridPropVariant { Type = 72, PointerValue = valuePointer };
        try { store.SetValue(ref key, ref value); }
        finally { Clear(ref value); }
    }

    private static HexiGridPropVariant Read(HexiGridPropertyStore store, HexiGridPropertyKey key, ushort expectedType)
    {
        HexiGridPropVariant value;
        store.GetValue(ref key, out value);
        if (value.Type != expectedType) { Clear(ref value); throw new InvalidOperationException("The Start Menu shortcut notification property has the wrong type."); }
        return value;
    }

    private static string ReadString(HexiGridPropertyStore store, HexiGridPropertyKey key)
    {
        HexiGridPropVariant value = Read(store, key, 31);
        try { return Marshal.PtrToStringUni(value.PointerValue); }
        finally { Clear(ref value); }
    }

    private static Guid ReadGuid(HexiGridPropertyStore store, HexiGridPropertyKey key)
    {
        HexiGridPropVariant value = Read(store, key, 72);
        try { return Marshal.PtrToStructure<Guid>(value.PointerValue); }
        finally { Clear(ref value); }
    }
}
'@

if (-not ('HexiGridToastShortcut' -as [type])) { Add-Type -TypeDefinition $source -Language CSharp }
if ($VerifyOnly) {
  [HexiGridToastShortcut]::VerifyOnly([IO.Path]::GetFullPath($ShortcutPath), $AppUserModelId, $ToastActivatorClsid.ToString())
} else {
  [HexiGridToastShortcut]::SetAndVerify([IO.Path]::GetFullPath($ShortcutPath), $AppUserModelId, $ToastActivatorClsid.ToString())
}
Write-Output "Verified HexiGrid Windows toast identity on $ShortcutPath."
