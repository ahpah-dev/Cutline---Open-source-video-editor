import { useEffect, useSyncExternalStore } from "react";
import { Check, Palette } from "lucide-react";
import { applyTheme, currentTheme, subscribeTheme, THEMES, type ThemeId } from "./themes";
export function ThemePicker(){
  const theme=useSyncExternalStore<ThemeId>(subscribeTheme,currentTheme,()=>"graphite");
  useEffect(()=>{applyTheme(theme);},[theme]);
  return <details className="theme-picker"><summary aria-label="Change theme" title="Change the entire workspace theme"><Palette size={15}/><span>Theme</span></summary><div className="popover theme-popover"><strong>Workspace appearance</strong><p>Includes the topbar. Your footage is unchanged.</p><div role="group" aria-label="Workspace theme">{THEMES.map(option=><button key={option.id} type="button" aria-pressed={theme===option.id} onClick={()=>applyTheme(option.id,true)}><i style={{background:option.color}}/><span>{option.name}<small>{option.description}</small></span>{theme===option.id&&<Check size={15}/>}</button>)}</div></div></details>;
}
