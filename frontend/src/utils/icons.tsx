import { LucideIcon, icons } from 'lucide-react';

/**
 * Dynamic Lucide icon lookup by name
 * 
 * Converts a string icon name (e.g., "book", "box", "settings")
 * to the corresponding Lucide icon component.
 * 
 * The icon name should be in kebab-case or lowercase.
 * Returns a fallback icon if the name is not found.
 */
export function getIconByName(iconName: string): LucideIcon {
  // Normalize the icon name: convert kebab-case to PascalCase
  // e.g., "book" -> "Book", "arrow-left" -> "ArrowLeft"
  const pascalCase = iconName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');

  // Look up the icon in lucide-react's icons object
  const icon = icons[pascalCase as keyof typeof icons];
  
  if (icon) {
    return icon;
  }

  // Fallback: try exact match (some icons might already be PascalCase)
  const exactMatch = icons[iconName as keyof typeof icons];
  if (exactMatch) {
    return exactMatch;
  }

  // Default fallback icon
  return icons.Box;
}

/**
 * Render a dynamic Lucide icon by name
 */
export function DynamicIcon({ 
  name, 
  size = 18, 
  className = '' 
}: { 
  name: string; 
  size?: number; 
  className?: string;
}) {
  const IconComponent = getIconByName(name);
  return <IconComponent size={size} className={className} />;
}
