// The monochrome page icons ("icon:<name>:<color>", Notion's icon set): ~150
// lucide icons, loaded only when a page uses one or the icon picker opens
// (they made up most of lucide's 36 KB in the workspace's first chunk).

import {
  Anchor, Apple, Archive, Atom, Award, BarChart3, Bell, Bike, Book, BookOpen, Bookmark, Box, Brain, Briefcase, Brush, Bug, Building2, Cake, Calculator,
  Calendar, CalendarDays, Camera, Car, CheckSquare, ClipboardCheck, ClipboardList, Clock, Cloud, CloudSun, Code, Coffee, Cog, Compass, Cpu, CreditCard,
  Crown, Database, Dices, DollarSign, Dumbbell, Feather, File, FileText, Film, Flag, FlaskConical, Flame, Flower2, Folder, FolderOpen, Gamepad2, Gem,
  Gift, Globe, GraduationCap, Hammer, Headphones, Heart, HeartPulse, Home, Image, Inbox, Key, Languages, Laptop, Layers, LayoutGrid, Leaf, Library,
  Lightbulb, LineChart, Link, ListTodo, Lock, Mail, Map, MapPin, Medal, Megaphone, MessageCircle, Mic, Microscope, Monitor, Moon, Mountain, Music,
  Newspaper, Notebook, NotebookPen, Package, Palette, Paperclip, Pencil, PenTool, Phone, PieChart, Pill, Pizza, Plane, Puzzle, Receipt, Rocket,
  School, ScrollText, Send, Server, Settings, Share2, Shield, ShoppingBag, ShoppingCart, Smartphone, Smile, Sparkles, Star, Stethoscope, StickyNote,
  Sun, Target, Terminal, ThumbsUp, Timer, Trees, TrendingUp, Trophy, Umbrella, User, Users, Video, Wallet, Waves, Wifi, Wrench, Zap,
  type LucideIcon,
} from "lucide-react";

export const ICONS: Record<string, LucideIcon> = {
  "file-text": FileText, file: File, folder: Folder, "folder-open": FolderOpen, book: Book, "book-open": BookOpen, bookmark: Bookmark, library: Library,
  notebook: Notebook, "notebook-pen": NotebookPen, "clipboard-list": ClipboardList, "clipboard-check": ClipboardCheck, "sticky-note": StickyNote,
  newspaper: Newspaper, scroll: ScrollText, "list-todo": ListTodo, "check-square": CheckSquare, inbox: Inbox, archive: Archive, layers: Layers, grid: LayoutGrid,
  briefcase: Briefcase, building: Building2, calendar: Calendar, "calendar-days": CalendarDays, clock: Clock, timer: Timer, target: Target, flag: Flag,
  rocket: Rocket, trophy: Trophy, award: Award, medal: Medal, crown: Crown, star: Star, heart: Heart, "thumbs-up": ThumbsUp, lightbulb: Lightbulb, zap: Zap,
  sparkles: Sparkles, flame: Flame, gem: Gem, "trending-up": TrendingUp, "bar-chart": BarChart3, "line-chart": LineChart, "pie-chart": PieChart,
  dollar: DollarSign, wallet: Wallet, card: CreditCard, receipt: Receipt, package: Package, box: Box, puzzle: Puzzle,
  code: Code, terminal: Terminal, bug: Bug, database: Database, server: Server, cpu: Cpu, laptop: Laptop, smartphone: Smartphone, monitor: Monitor,
  globe: Globe, wifi: Wifi, cloud: Cloud, link: Link, lock: Lock, key: Key, shield: Shield, settings: Settings, cog: Cog, wrench: Wrench, hammer: Hammer,
  mail: Mail, message: MessageCircle, phone: Phone, users: Users, user: User, smile: Smile, bell: Bell, megaphone: Megaphone, send: Send, share: Share2,
  paperclip: Paperclip, image: Image, camera: Camera, video: Video, film: Film, music: Music, headphones: Headphones, mic: Mic, palette: Palette,
  brush: Brush, "pen-tool": PenTool, pencil: Pencil, feather: Feather,
  "graduation-cap": GraduationCap, school: School, calculator: Calculator, flask: FlaskConical, atom: Atom, microscope: Microscope, brain: Brain,
  languages: Languages, sun: Sun, moon: Moon, "cloud-sun": CloudSun, leaf: Leaf, trees: Trees, flower: Flower2, mountain: Mountain, waves: Waves,
  coffee: Coffee, pizza: Pizza, apple: Apple, cake: Cake, cart: ShoppingCart, bag: ShoppingBag, gift: Gift, home: Home, car: Car, plane: Plane,
  bike: Bike, map: Map, "map-pin": MapPin, compass: Compass, dumbbell: Dumbbell, "heart-pulse": HeartPulse, pill: Pill, stethoscope: Stethoscope,
  gamepad: Gamepad2, dice: Dices, anchor: Anchor, umbrella: Umbrella,
};

