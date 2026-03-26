import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface PricingToggleProps {
  isAnnual: boolean;
  onToggle: (value: boolean) => void;
}

export function PricingToggle({ isAnnual, onToggle }: PricingToggleProps) {
  return (
    <div className="flex items-center gap-4  mb-4">
      <Label htmlFor="billing-toggle" className="text-sm">
        monthly
      </Label>
      <Switch
        id="billing-toggle"
        checked={isAnnual}
        onCheckedChange={onToggle}
      />
      <Label htmlFor="billing-toggle" className="text-sm">
        annual (4 months free)
      </Label>
    </div>
  );
}
