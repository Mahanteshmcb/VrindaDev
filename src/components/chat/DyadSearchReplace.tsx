import type React from "react";
import { useState } from "react";
import { ChevronsDownUp, ChevronsUpDown, Search } from "lucide-react";
import { CodeHighlight } from "./CodeHighlight";

interface DyadSearchReplaceProps {
  children?: React.ReactNode;
  node?: any;
  path?: string;
  description?: string;
}

export const DyadSearchReplace: React.FC<DyadSearchReplaceProps> = ({
  children,
  node,
  path: pathProp,
  description: descriptionProp,
}) => {
  const [isContentVisible, setIsContentVisible] = useState(false);

  const path = pathProp || node?.properties?.path || "";
  const description = descriptionProp || node?.properties?.description || "";
  const fileName = path ? path.split("/").pop() : "";

  return (
    <div
      className="bg-(--background-lightest) hover:bg-(--background-lighter) rounded-lg px-4 py-2 border border-border my-2 cursor-pointer"
      onClick={() => setIsContentVisible(!isContentVisible)}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex items-center">
            <Search size={16} />
            <span className="bg-purple-600 text-white text-xs px-1.5 py-0.5 rounded ml-1 font-medium">
              Search & Replace
            </span>
          </div>
          {fileName && (
            <span className="text-gray-700 dark:text-gray-300 font-medium text-sm">
              {fileName}
            </span>
          )}
        </div>
        <div className="flex items-center">
          {isContentVisible ? (
            <ChevronsDownUp
              size={20}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            />
          ) : (
            <ChevronsUpDown
              size={20}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            />
          )}
        </div>
      </div>
      {path && (
        <div className="text-xs text-gray-500 dark:text-gray-400 font-medium mb-1">
          {path}
        </div>
      )}
      {description && (
        <div className="text-sm text-gray-600 dark:text-gray-300">
          <span className="font-medium">Summary: </span>
          {description}
        </div>
      )}
      {isContentVisible && (
        <div
          className="text-xs cursor-text mt-2"
          onClick={(e) => e.stopPropagation()}
        >
          <CodeHighlight className="language-typescript">
            {String(children || "")}
          </CodeHighlight>
        </div>
      )}
    </div>
  );
};