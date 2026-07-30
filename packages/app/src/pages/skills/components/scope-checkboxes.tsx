import { Checkbox } from "@/components/ui/checkbox";
import { SKILL_SCOPE_LABELS, type SkillScope } from "@/services/skill-service";

const SCOPE_ORDER: SkillScope[] = ["central", "reader", "paper"];

interface ScopeCheckboxesProps {
  value: SkillScope[];
  onChange: (next: SkillScope[]) => void;
  disabled?: boolean;
}

/** 生效范围复选框组（全局助手/阅读助手/论文助手）；是否允许全不选由调用方校验 */
export function ScopeCheckboxes({ value, onChange, disabled }: ScopeCheckboxesProps) {
  const toggle = (scope: SkillScope, checked: boolean) => {
    onChange(checked ? [...value, scope] : value.filter((s) => s !== scope));
  };

  return (
    <div className="flex flex-wrap items-center gap-4">
      {SCOPE_ORDER.map((scope) => (
        <label key={scope} className="flex cursor-pointer items-center gap-1.5 text-sm">
          <Checkbox
            checked={value.includes(scope)}
            onCheckedChange={(checked) => toggle(scope, checked === true)}
            disabled={disabled}
          />
          {SKILL_SCOPE_LABELS[scope]}
        </label>
      ))}
    </div>
  );
}
