// zvena's shared components (the "Дизайн-система zvena" artifact). The look
// is app/ui-theme.css (--ui-* tokens); faces, density and the components'
// styles are ds.css, which every component here imports.
//
//   Shell, ShellNavItem, ShellNavList   one frame for every section
//   Pill                                a property, edited in one click
//   ViewSwitcher                        list / board / table / calendar / timeline
//   Switch                              an on/off setting (role="switch")
//   ListRow                             a dense row (Linear's)
//   SelectionBar, SelectionAction       bulk actions from 2 selected rows
//   EmptyStart                          an empty screen that offers the next step
//   ObjectCard, ObjectGrid              an object with a face (on eco's Card)
//   toast(), Toaster                    one toast at a time, with Undo and ⌘Z
//   ShareButton, ShareDialog            invite by e-mail or link; start a team from a personal workspace
//   Kbd                                 a shortcut next to its action
//   isTyping, overlayOpen, formatKeys   keyboard helpers

export { Shell, ShellNavItem, ShellNavList, type ShellProps, type ShellSection, type ShellUser, type ShellNavItemProps } from "./Shell";
export { Pill, ViewSwitcher, ListRow, SelectionBar, SelectionAction, EmptyStart, Switch, type PillProps, type PillTone, type ViewOption, type ListRowProps, type Start, type SwitchProps } from "./parts";
export { ObjectCard, ObjectGrid, type ObjectCardProps } from "./ObjectCard";
export { relativeTime } from "./time";
export { Toaster } from "./Toaster";
export { ShareButton, ShareDialog } from "./Share";
export { LanguagePicker, setLanguage } from "./LanguagePicker";
export { toast, toasts, ToastStore, type ToastOptions, type ToastKind, type ToastItem } from "./toast-store";
export { Kbd, useApple } from "./Kbd";
export { isTyping, overlayOpen, formatKeys, isApple } from "./keys";
export { dt, type DsKey } from "./i18n";
