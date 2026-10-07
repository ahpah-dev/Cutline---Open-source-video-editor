export const THEMES=[{id:"graphite",name:"Graphite",description:"Neutral studio",color:"#a7ebda"},{id:"midnight",name:"Midnight",description:"Deep blue & lavender",color:"#b9b2ff"},{id:"forest",name:"Forest",description:"Warm green & sage",color:"#c0db9c"},{id:"light",name:"Light",description:"Bright, calm & clear",color:"#166b56"}] as const;
export type ThemeId=typeof THEMES[number]["id"];
const STORAGE="cutline.appearance.v1";
let activeTheme:ThemeId|undefined;
export const validTheme=(value:unknown):ThemeId=>THEMES.some(theme=>theme.id===value)?value as ThemeId:"graphite";
export function savedTheme():ThemeId{try{return validTheme(localStorage.getItem(STORAGE));}catch{return "graphite";}}
export const currentTheme=():ThemeId=>activeTheme??savedTheme();
export function subscribeTheme(change:()=>void){const storage=()=>{activeTheme=savedTheme();change();};window.addEventListener("cutline-theme-change",change);window.addEventListener("storage",storage);return()=>{window.removeEventListener("cutline-theme-change",change);window.removeEventListener("storage",storage);};}
export function applyTheme(value:ThemeId,save=false){const theme=validTheme(value);activeTheme=theme;document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme==="light"?"light":"dark";if(save)try{localStorage.setItem(STORAGE,theme);}catch{/* A blocked preference store does not stop editing. */}window.dispatchEvent(new Event("cutline-theme-change"));}
