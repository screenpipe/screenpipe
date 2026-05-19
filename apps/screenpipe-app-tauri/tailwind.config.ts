/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  prefix: "",
  theme: {
	container: {
		center: "true",
		padding: "2rem",
		screens: {
		  "2xl": "1400px",
		},
	  },
	  extend: {
		fontFamily: {
		  /* Screenpipe Brand: Monospace primary */
		  sans: ["JetBrains Mono", "SF Mono", "IBM Plex Mono", "ui-monospace", "monospace"],
		  mono: ["JetBrains Mono", "SF Mono", "IBM Plex Mono", "ui-monospace", "monospace"],
		},
		colors: {
		  // Base colors
		  border: "hsl(var(--border))",
		  input: {
			DEFAULT: "hsl(var(--input))",
			focus: "hsl(var(--input-focus))",
		  },
		  ring: "hsl(var(--ring))",
		  background: "hsl(var(--background))",
		  foreground: "hsl(var(--foreground))",
		  
		  // Surface colors
		  surface: {
			DEFAULT: "hsl(var(--surface))",
			secondary: "hsl(var(--surface-secondary))",
			tertiary: "hsl(var(--surface-tertiary))",
		  },
		  
		  // Primary brand colors
		  primary: {
			DEFAULT: "hsl(var(--primary))",
			foreground: "hsl(var(--primary-foreground))",
			hover: "hsl(var(--primary-hover))",
			muted: "hsl(var(--primary-muted))",
		  },
		  
		  // Secondary colors
		  secondary: {
			DEFAULT: "hsl(var(--secondary))",
			foreground: "hsl(var(--secondary-foreground))",
			hover: "hsl(var(--secondary-hover))",
		  },
		  
		  // Success colors
		  success: {
			DEFAULT: "hsl(var(--success))",
			foreground: "hsl(var(--success-foreground))",
			muted: "hsl(var(--success-muted))",
		  },
		  
		  // Warning colors
		  warning: {
			DEFAULT: "hsl(var(--warning))",
			foreground: "hsl(var(--warning-foreground))",
			muted: "hsl(var(--warning-muted))",
		  },
		  
		  // Error/Destructive colors
		  destructive: {
			DEFAULT: "hsl(var(--destructive))",
			foreground: "hsl(var(--destructive-foreground))",
			hover: "hsl(var(--destructive-hover))",
			muted: "hsl(var(--destructive-muted))",
		  },
		  
		  // Info colors
		  info: {
			DEFAULT: "hsl(var(--info))",
			foreground: "hsl(var(--info-foreground))",
			muted: "hsl(var(--info-muted))",
		  },
		  
		  // Muted colors
		  muted: {
			DEFAULT: "hsl(var(--muted))",
			foreground: "hsl(var(--muted-foreground))",
		  },
		  
		  // Accent colors
		  accent: {
			DEFAULT: "hsl(var(--accent))",
			foreground: "hsl(var(--accent-foreground))",
			hover: "hsl(var(--accent-hover))",
		  },
		  
		  // Card colors
		  card: {
			DEFAULT: "hsl(var(--card))",
			foreground: "hsl(var(--card-foreground))",
			hover: "hsl(var(--card-hover))",
		  },
		  
		  // Popover colors
		  popover: {
			DEFAULT: "hsl(var(--popover))",
			foreground: "hsl(var(--popover-foreground))",
		  },
		  
		  // Text colors
		  text: {
			primary: "hsl(var(--text-primary))",
			secondary: "hsl(var(--text-secondary))",
			tertiary: "hsl(var(--text-tertiary))",
			disabled: "hsl(var(--text-disabled))",
		  },
		  
		  // Brand accent colors
		  brand: {
			1: "hsl(var(--brand-1))",
			2: "hsl(var(--brand-2))",
			3: "hsl(var(--brand-3))",
			4: "hsl(var(--brand-4))",
			5: "hsl(var(--brand-5))",
		  },
		  
		  // Legacy color mappings for backward compatibility
		  "color-1": "hsl(var(--brand-1))",
		  "color-2": "hsl(var(--brand-2))",
		  "color-3": "hsl(var(--brand-3))",
		  "color-4": "hsl(var(--brand-4))",
		  "color-5": "hsl(var(--brand-5))",
		  
		  // Sidebar colors
		  sidebar: {
			DEFAULT: "hsl(var(--sidebar-background))",
			foreground: "hsl(var(--sidebar-foreground))",
			primary: "hsl(var(--sidebar-primary))",
			"primary-foreground": "hsl(var(--sidebar-primary-foreground))",
			accent: "hsl(var(--sidebar-accent))",
			"accent-foreground": "hsl(var(--sidebar-accent-foreground))",
			border: "hsl(var(--sidebar-border))",
			ring: "hsl(var(--sidebar-ring))",
		  },
		},
		borderRadius: {
		  lg: "var(--radius)",
		  md: "calc(var(--radius) - 2px)",
		  sm: "calc(var(--radius) - 4px)",
		},
		keyframes: {
		  blink: {
			"0%, 100%": { opacity: "1" },
			"50%": { opacity: "0" },
		  },
		  "accordion-down": {
			from: {
			  height: "0",
			},
			to: {
			  height: "var(--radix-accordion-content-height)",
			},
		  },
		  "accordion-up": {
			from: {
			  height: "var(--radix-accordion-content-height)",
			},
			to: {
			  height: "0",
			},
		  },
		  pulse: {
			"0%, 100%": {
			  opacity: "1",
			},
			"50%": {
			  opacity: ".5",
			},
		  },
		  rainbow: {
			"0%": {
			  "background-position": "0%",
			},
			"100%": {
			  "background-position": "200%",
			},
		  },
		  "owned-browser-load": {
			"0%": { transform: "translateX(-100%)" },
			"100%": { transform: "translateX(400%)" },
		  },
		},
		animation: {
		  "accordion-down": "accordion-down 0.2s ease-out",
		  "accordion-up": "accordion-up 0.2s ease-out",
		  pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
		  rainbow: "rainbow var(--speed, 2s) infinite linear",
		  "owned-browser-load":
			"owned-browser-load 1.1s ease-in-out infinite",
		},
	  }
	  
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
};
