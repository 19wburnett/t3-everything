// Every OS-visible name differs from upstream T3 Code so both apps install and run side by side.

export const APP_SCHEME = "t3everything";
export const APP_DEVELOPMENT_SCHEME = "t3everything-dev";
/** Readers also take upstream schemes: the mobile app still registers `t3code`. */
export const APP_LINK_PROTOCOL = /^(?:t3code|t3everything)(?:-[a-z]+)?:$/;

export const T3_HOME_DIR_NAME = ".t3-everything";

export const DESKTOP_APP_ID = "com.t3everything.desktop";
export const DESKTOP_DEVELOPMENT_APP_ID = "com.t3everything.desktop.dev";
export const DESKTOP_USER_DATA_DIR_NAME = "t3everything";
export const DESKTOP_DEVELOPMENT_USER_DATA_DIR_NAME = "t3everything-dev";
/** Linux executable, WM class, and packaged `.desktop` basename. */
export const DESKTOP_LINUX_EXECUTABLE_NAME = "t3everything";
export const DESKTOP_LINUX_DESKTOP_ENTRY_ID = "com.t3everything.T3Everything";
