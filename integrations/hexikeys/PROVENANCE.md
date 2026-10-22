# Source and dependency provenance

The owner requested this addon from the local standalone **Build simple password manager** task, Codex chat `01a0ad20-eba9-7bb3-bcd3-497f9dae7e3e`. The checked-in source manifest records each explicitly copied source file's SHA-256. The standalone checkout had no checked-in release revision or separate license notice at review; this snapshot is not a published upstream release. Root repository distribution terms and the owner's publication approval gate remain applicable. Separate standalone redistribution rights remain an owner review item.

The local Windows build used Python 3.14.7, cryptography 50.0.2, CFFI 2.1.1 and PyInstaller 6.22.3. Pillow 12.3.0 generates the icon during builds. Verbatim installed license texts are under `notices/`: Python's bundled license collection, cryptography's license selection and both full texts, CFFI, PyInstaller (including its bootloader exception), and Pillow. These notices travel with the addon package.

This is an initial component inventory, not a completed redistribution audit of the executable. The statically linked cryptographic dependencies, Python's Tcl/Tk/OpenSSL runtime components, runtime hooks and their full required notices still require reconciliation before distributing a release. No public release is authorized or performed.
