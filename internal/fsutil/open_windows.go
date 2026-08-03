//go:build windows

package fsutil

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// OpenInFileManager opens path in Windows Explorer. If path is a file,
// Explorer opens its parent folder and selects the file. If path is a
// directory (or stat fails), Explorer opens the path or its parent directory.
//
// Uses ShellExecute instead of exec.Command because explorer.exe is a
// single-instance shell: a new process started via CreateProcess forwards its
// command line to the already-running explorer instance over DDE, which often
// drops the path argument and falls back to the Documents folder. ShellExecute
// goes through the shell and correctly delivers the path.
func OpenInFileManager(path string) error {
	verb, _ := windows.UTF16PtrFromString("open")
	fi, err := os.Stat(path)
	if err == nil && !fi.IsDir() {
		// File: launch explorer.exe with /select,"path" to highlight it.
		exe, _ := windows.UTF16PtrFromString("explorer.exe")
		params, _ := windows.UTF16PtrFromString(`/select,"` + path + `"`)
		return windows.ShellExecute(0, verb, exe, params, nil, windows.SW_SHOWNORMAL)
	}
	if err != nil {
		// Stat failed: fall back to opening the parent directory.
		dir := filepath.Dir(path)
		if dir != "" && dir != "." {
			_ = os.MkdirAll(dir, 0755)
			path = dir
		}
	}
	// Directory (or stat-failed fallback): open path with the default verb.
	file, _ := windows.UTF16PtrFromString(path)
	return windows.ShellExecute(0, verb, file, nil, nil, windows.SW_SHOWNORMAL)
}

// OpenInBrowser opens the given URL in the default web browser using
// rundll32 url.dll,FileProtocolHandler. The console window is hidden.
func OpenInBrowser(url string) error {
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	hideWindow(cmd)
	return cmd.Start()
}

// OpenFilePicker shows the modern Windows Common Item Dialog (IFileOpenDialog)
// for selecting a file. The filter parameter uses the standard format
// (e.g. "Executables (*.exe)|*.exe|All Files (*.*)|*.*"). If filter is empty,
// all files are shown. Returns empty string if the user cancelled.
func OpenFilePicker(filter string) (string, error) {
	return OpenFilePickerAt(filter, "")
}

// OpenFilePickerAt is like OpenFilePicker but starts the dialog in the given
// directory. If initialDir is empty, the dialog opens at the default location.
func OpenFilePickerAt(filter, initialDir string) (string, error) {
	return showCommonDialog(false, filter, initialDir)
}

// OpenDirectoryPicker shows the modern Windows Common Item Dialog
// (IFileOpenDialog with FOS_PICKFOLDERS) for selecting a directory.
// Returns empty string if the user cancelled.
func OpenDirectoryPicker() (string, error) {
	return OpenDirectoryPickerAt("")
}

// OpenDirectoryPickerAt is like OpenDirectoryPicker but starts the dialog in
// the given directory. If initialDir is empty, the dialog opens at the default
// location.
func OpenDirectoryPickerAt(initialDir string) (string, error) {
	return showCommonDialog(true, "", initialDir)
}

// ---------- Common Item Dialog (IFileOpenDialog) via raw COM ----------
// This is the same native dialog that the browser's showSaveFilePicker /
// showOpenFilePicker uses internally. It provides the modern Windows 10/11
// file dialog appearance and returns absolute filesystem paths.

var (
	iidIFileOpenDialog  = windows.GUID{Data1: 0xd57c7288, Data2: 0xd4ad, Data3: 0x4768, Data4: [8]byte{0xbe, 0x02, 0x9d, 0x96, 0x95, 0x32, 0xd9, 0x60}}
	clsidFileOpenDialog = windows.GUID{Data1: 0xdc1c5a9c, Data2: 0xe88a, Data3: 0x4dde, Data4: [8]byte{0xa5, 0xa1, 0x60, 0xf8, 0x2a, 0x20, 0xae, 0xf7}}
	iidIShellItem       = windows.GUID{Data1: 0x43826d1e, Data2: 0xe718, Data3: 0x42ee, Data4: [8]byte{0xbc, 0x55, 0xa1, 0xe2, 0x61, 0xc3, 0x7b, 0xfe}}
)

const (
	fosPickFolders     = 0x00000020
	fosForceFilesystem = 0x00000040
	sigdnFilesysPath   = 0x80058000
)

// comdlgFilterSpec mirrors the COMDLG_FILTERSPEC struct.
type comdlgFilterSpec struct {
	Name *uint16
	Spec *uint16
}

// IFileDialog vtable indices (after IUnknown: 0-2, IModalWindow: 3).
// showCommonDialog displays the modern IFileOpenDialog COM dialog.
// If pickFolder is true, the dialog selects directories instead of files.
// If initialDir is non-empty, the dialog starts in that directory.
func showCommonDialog(pickFolder bool, filter string, initialDir string) (string, error) {
	const (
		vtblShow         = 3
		vtblSetFileTypes = 4
		vtblGetOptions   = 8
		vtblSetOptions   = 9
		vtblSetFolder    = 12
		vtblGetResult    = 20
	)
	const (
		vtblGetDisplayName = 5
	)

	ole32 := windows.NewLazySystemDLL("ole32.dll")
	shell32 := windows.NewLazySystemDLL("shell32.dll")
	procCoInit := ole32.NewProc("CoInitializeEx")
	procCoUninit := ole32.NewProc("CoUninitialize")
	procCoCreate := ole32.NewProc("CoCreateInstance")
	procTaskMemFree := ole32.NewProc("CoTaskMemFree")
	procSHCreateItem := shell32.NewProc("SHCreateItemFromParsingName")

	// Initialize COM (STA).
	hr, _, _ := procCoInit.Call(0, 2) // COINIT_APARTMENTTHREADED
	if hr != 0 && hr != 1 {           // S_OK or S_FALSE (already initialized)
		return "", fmt.Errorf("CoInitializeEx failed: 0x%08x", hr)
	}
	defer procCoUninit.Call()

	// Create IFileOpenDialog instance.
	var dlgPtr unsafe.Pointer
	hr, _, _ = procCoCreate.Call(
		uintptr(unsafe.Pointer(&clsidFileOpenDialog)),
		0,
		1, // CLSCTX_INPROC_SERVER
		uintptr(unsafe.Pointer(&iidIFileOpenDialog)),
		uintptr(unsafe.Pointer(&dlgPtr)),
	)
	if hr != 0 {
		return "", fmt.Errorf("CoCreateInstance(IFileOpenDialog) failed: 0x%08x", hr)
	}
	defer syscall.SyscallN(vtblRelease(dlgPtr), uintptr(dlgPtr))

	// Set initial directory if provided. Resolve to absolute so
	// SHCreateItemFromParsingName can create the shell item (it rejects
	// relative paths like ".").
	if initialDir != "" {
		if abs, err := filepath.Abs(initialDir); err == nil {
			initialDir = abs
		}
		path16, err := windows.UTF16PtrFromString(initialDir)
		if err == nil {
			var shellItemPtr unsafe.Pointer
			hr, _, _ = procSHCreateItem.Call(
				uintptr(unsafe.Pointer(path16)), // PCWSTR pszPath
				0,                               // IBindCtx *pbc (NULL)
				uintptr(unsafe.Pointer(&iidIShellItem)),
				uintptr(unsafe.Pointer(&shellItemPtr)),
			)
			if hr == 0 && shellItemPtr != nil {
				syscall.SyscallN(vtblMethod(dlgPtr, vtblSetFolder),
					uintptr(dlgPtr), uintptr(shellItemPtr))
				syscall.SyscallN(vtblRelease(shellItemPtr), uintptr(shellItemPtr))
			}
		}
	}

	// Get current options.
	var opts uint32
	syscall.SyscallN(vtblMethod(dlgPtr, vtblGetOptions), uintptr(dlgPtr), uintptr(unsafe.Pointer(&opts)))
	opts |= fosForceFilesystem
	if pickFolder {
		opts |= fosPickFolders
	}
	syscall.SyscallN(vtblMethod(dlgPtr, vtblSetOptions), uintptr(dlgPtr), uintptr(opts))

	// Set file type filter (only for file mode).
	if !pickFolder && filter != "" {
		specs := parseFilter(filter)
		if len(specs) > 0 {
			syscall.SyscallN(vtblMethod(dlgPtr, vtblSetFileTypes),
				uintptr(dlgPtr), uintptr(len(specs)), uintptr(unsafe.Pointer(&specs[0])))
		}
	}

	// Show the dialog (blocks until user closes it).
	hr, _, _ = syscall.SyscallN(vtblMethod(dlgPtr, vtblShow), uintptr(dlgPtr), 0)
	if hr != 0 {
		// User cancelled or dialog error — not a hard failure.
		return "", nil
	}

	// Get the selected item (IShellItem).
	var itemPtr unsafe.Pointer
	hr, _, _ = syscall.SyscallN(vtblMethod(dlgPtr, vtblGetResult), uintptr(dlgPtr), uintptr(unsafe.Pointer(&itemPtr)))
	if hr != 0 {
		return "", nil
	}
	defer syscall.SyscallN(vtblRelease(itemPtr), uintptr(itemPtr))

	// Get the filesystem path via IShellItem::GetDisplayName(SIGDN_FILESYSPATH).
	var pathPtr *uint16
	hr, _, _ = syscall.SyscallN(vtblMethod(itemPtr, vtblGetDisplayName),
		uintptr(itemPtr), uintptr(sigdnFilesysPath), uintptr(unsafe.Pointer(&pathPtr)))
	if hr != 0 {
		return "", nil
	}
	defer procTaskMemFree.Call(uintptr(unsafe.Pointer(pathPtr)))

	return windows.UTF16PtrToString(pathPtr), nil
}

// vtblMethod returns the function pointer at the given vtable index for a COM object.
func vtblMethod(obj unsafe.Pointer, index int) uintptr {
	vtbl := *(*[]uintptr)(unsafe.Pointer(&struct {
		ptr  unsafe.Pointer
		size int
		cap  int
	}{ptr: *(*unsafe.Pointer)(obj), size: 64, cap: 64}))
	return vtbl[index]
}

// vtblRelease returns the Release method (vtable index 2) for a COM object.
func vtblRelease(obj unsafe.Pointer) uintptr {
	return vtblMethod(obj, 2)
}

// parseFilter converts a .NET-style filter string ("Name|pattern|Name2|pattern2")
// into COMDLG_FILTERSPEC entries for IFileOpenDialog.SetFileTypes.
func parseFilter(filter string) []comdlgFilterSpec {
	parts := splitFilter(filter)
	var specs []comdlgFilterSpec
	for i := 0; i+1 < len(parts); i += 2 {
		namePtr, _ := windows.UTF16PtrFromString(parts[i])
		specPtr, _ := windows.UTF16PtrFromString(parts[i+1])
		specs = append(specs, comdlgFilterSpec{
			Name: namePtr,
			Spec: specPtr,
		})
	}
	return specs
}

// splitFilter splits "Name|*.ext|Name2|*.ext2" by '|'.
func splitFilter(s string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '|' {
			parts = append(parts, s[start:i])
			start = i + 1
		}
	}
	parts = append(parts, s[start:])
	return parts
}

// hideWindow sets SysProcAttr to hide the console window and suppress
// CREATE_NO_WINDOW for PowerShell/exec commands.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
