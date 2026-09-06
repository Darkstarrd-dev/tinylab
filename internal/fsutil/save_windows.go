//go:build windows

package fsutil

import (
	"fmt"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	iidIFileSaveDialog  = windows.GUID{Data1: 0x84bccd23, Data2: 0x5fde, Data3: 0x4cdb, Data4: [8]byte{0xae, 0xa4, 0xaf, 0x64, 0xb8, 0x3d, 0x78, 0xab}}
	clsidFileSaveDialog = windows.GUID{Data1: 0xc0b4e2f3, Data2: 0xba21, Data3: 0x4773, Data4: [8]byte{0x8d, 0xba, 0x33, 0x5e, 0xc9, 0x46, 0xeb, 0x8b}}
)

const (
	fosOverwritePrompt = 0x00000002
	fosPathMustExist   = 0x00000800
	fosFileMustExist   = 0x00001000
	hrUserCancelled    = 0x800704c7 // HRESULT_FROM_WIN32(ERROR_CANCELLED)
)

// SaveFilePickerAt displays the Windows modern IFileSaveDialog COM dialog.
// Allows user to pick a target save path with optional initial directory,
// suggested filename, and filter.
func SaveFilePickerAt(filter, initialDir, suggestedName string) (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	const (
		vtblShow         = 3  // IModalWindow::Show
		vtblSetFileTypes = 4  // IFileDialog::SetFileTypes
		vtblSetOptions   = 9  // IFileDialog::SetOptions
		vtblGetOptions   = 10 // IFileDialog::GetOptions
		vtblSetFolder    = 12 // IFileDialog::SetFolder
		vtblSetFileName  = 15 // IFileDialog::SetFileName
		vtblGetResult    = 20 // IFileDialog::GetResult
		vtblGetDisplayName = 5 // IShellItem::GetDisplayName
	)

	ole32 := windows.NewLazySystemDLL("ole32.dll")
	shell32 := windows.NewLazySystemDLL("shell32.dll")
	procCoInit := ole32.NewProc("CoInitializeEx")
	procCoUninit := ole32.NewProc("CoUninitialize")
	procCoCreate := ole32.NewProc("CoCreateInstance")
	procTaskMemFree := ole32.NewProc("CoTaskMemFree")
	procSHCreateItem := shell32.NewProc("SHCreateItemFromParsingName")

	// Initialize COM (STA)
	hr, _, _ := procCoInit.Call(0, 2) // COINIT_APARTMENTTHREADED
	if hr != 0 && hr != 1 {
		return "", fmt.Errorf("CoInitializeEx failed: 0x%08x", hr)
	}
	defer procCoUninit.Call()

	// Create IFileSaveDialog instance
	var dlgPtr unsafe.Pointer
	hr, _, _ = procCoCreate.Call(
		uintptr(unsafe.Pointer(&clsidFileSaveDialog)),
		0,
		1, // CLSCTX_INPROC_SERVER
		uintptr(unsafe.Pointer(&iidIFileSaveDialog)),
		uintptr(unsafe.Pointer(&dlgPtr)),
	)
	if hr != 0 {
		return "", fmt.Errorf("CoCreateInstance(IFileSaveDialog) failed: 0x%08x", hr)
	}
	defer syscall.SyscallN(vtblRelease(dlgPtr), uintptr(dlgPtr))

	// Set initial folder if provided
	if initialDir != "" {
		if abs, err := filepath.Abs(initialDir); err == nil {
			initialDir = abs
		}
		path16, err := windows.UTF16PtrFromString(initialDir)
		if err == nil {
			var shellItemPtr unsafe.Pointer
			hr, _, _ = procSHCreateItem.Call(
				uintptr(unsafe.Pointer(path16)),
				0,
				uintptr(unsafe.Pointer(&iidIShellItem)),
				uintptr(unsafe.Pointer(&shellItemPtr)),
			)
			if hr == 0 && shellItemPtr != nil {
				syscall.SyscallN(vtblMethod(dlgPtr, vtblSetFolder), uintptr(dlgPtr), uintptr(shellItemPtr))
				syscall.SyscallN(vtblRelease(shellItemPtr), uintptr(shellItemPtr))
			}
		}
	}

	// Set suggested filename if provided
	if suggestedName != "" {
		name16, err := windows.UTF16PtrFromString(suggestedName)
		if err == nil {
			syscall.SyscallN(vtblMethod(dlgPtr, vtblSetFileName), uintptr(dlgPtr), uintptr(unsafe.Pointer(name16)))
		}
	}

	// Configure options
	var opts uint32
	syscall.SyscallN(vtblMethod(dlgPtr, vtblGetOptions), uintptr(dlgPtr), uintptr(unsafe.Pointer(&opts)))
	opts |= (fosForceFilesystem | fosOverwritePrompt | fosPathMustExist)
	opts &= ^uint32(fosFileMustExist)
	syscall.SyscallN(vtblMethod(dlgPtr, vtblSetOptions), uintptr(dlgPtr), uintptr(opts))

	// Set file type filters
	if filter != "" {
		specs := parseFilter(filter)
		if len(specs) > 0 {
			syscall.SyscallN(vtblMethod(dlgPtr, vtblSetFileTypes),
				uintptr(dlgPtr), uintptr(len(specs)), uintptr(unsafe.Pointer(&specs[0])))
		}
	}

	// Show dialog
	hr, _, _ = syscall.SyscallN(vtblMethod(dlgPtr, vtblShow), uintptr(dlgPtr), 0)
	if hr != 0 {
		if uint32(hr) == hrUserCancelled {
			return "", nil
		}
		return "", fmt.Errorf("IModalWindow::Show failed: 0x%08x", hr)
	}

	// Get result (IShellItem)
	var itemPtr unsafe.Pointer
	hr, _, _ = syscall.SyscallN(vtblMethod(dlgPtr, vtblGetResult), uintptr(dlgPtr), uintptr(unsafe.Pointer(&itemPtr)))
	if hr != 0 {
		return "", fmt.Errorf("IFileDialog::GetResult failed: 0x%08x", hr)
	}
	defer syscall.SyscallN(vtblRelease(itemPtr), uintptr(itemPtr))

	// Get filesystem path
	var pathPtr *uint16
	hr, _, _ = syscall.SyscallN(vtblMethod(itemPtr, vtblGetDisplayName),
		uintptr(itemPtr), uintptr(sigdnFilesysPath), uintptr(unsafe.Pointer(&pathPtr)))
	if hr != 0 {
		return "", fmt.Errorf("IShellItem::GetDisplayName failed: 0x%08x", hr)
	}
	defer procTaskMemFree.Call(uintptr(unsafe.Pointer(pathPtr)))

	return windows.UTF16PtrToString(pathPtr), nil
}
